import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(cors())

// === Config ===
const BOT_TOKEN = process.env.BOT_TOKEN || ''
const ALLOW_DEV = (process.env.ALLOW_DEV || 'true').toLowerCase() === 'true'
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me'
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || ''
const RUB_PER_SPIN = parseFloat(process.env.RUB_PER_SPIN || '100') // рублей доната за 1 крутку
const DA_CLIENT_ID = process.env.DA_CLIENT_ID || ''
const DA_CLIENT_SECRET = process.env.DA_CLIENT_SECRET || ''
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '')
const DA_REDIRECT_URI = process.env.DA_REDIRECT_URI || `${PUBLIC_URL}/da/callback`

// === Storage (в памяти, сбрасывается при перезапуске) ===
const users = Object.create(null)     // tgId -> { name, username, spins, donated }
const winsLog = []                    // журнал: { tgName, prize, at }
const pendingDonations = []           // донаты без совпадения по нику
const processedDonations = new Set()
let daFirstPollDone = false
let daTokens = { access_token: null, refresh_token: null, expires_at: 0 }

const norm = s => String(s || '').trim().toLowerCase().replace(/^@/, '')

function getUser(tgId, initDataUser) {
  if (!users[tgId]) {
    users[tgId] = {
      name: initDataUser.first_name || '',
      username: initDataUser.username || '',
      spins: 0,
      donated: 0
    }
  }
  return users[tgId]
}

// === Telegram initData verification ===
function verifyInitData(initData) {
  try {
    if (!initData || typeof initData !== 'string') return null
    const urlParams = new URLSearchParams(initData)
    const hash = urlParams.get('hash')
    if (!hash) return null
    urlParams.delete('hash')
    const pairs = []
    for (const [key, value] of urlParams.entries()) pairs.push(`${key}=${value}`)
    pairs.sort()
    const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest()
    const hmac = crypto.createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex')
    if (hmac !== hash) return null
    const userStr = urlParams.get('user')
    if (!userStr) return null
    return JSON.parse(userStr)
  } catch (e) {
    return null
  }
}

// === Prizes ===
let prizes = [
  { label: 'Любая наживка 5 шт', weight: 15999, color: '#F59E0B', id: 'bait5' },
  { label: 'Приманки на выбор', weight: 12000, color: '#10B981', id: 'bait_choice' },
  { label: '1 бутылка алкоголя', weight: 12000, color: '#EF4444', id: 'alcohol' },
  { label: 'Кофе 500', weight: 12000, color: '#D17722', id: 'coffee500' },
  { label: 'Кофе 1000', weight: 7000, color: '#8B5CF6', id: 'coffee1000' },
  { label: 'Золотая монета 1 шт', weight: 7000, color: '#EAB308', id: 'coin1' },
  { label: 'Премиум 3 дня', weight: 7000, color: '#3B82F6', id: 'prem3' },
  { label: 'Майка 10 шт', weight: 3000, color: '#EC4899', id: 'tshirt10' },
  { label: 'Нос 10 шт', weight: 3000, color: '#64748B', id: 'nos10' },
  { label: 'Бокоплав 10 шт', weight: 3000, color: '#06B6D4', id: 'bokoplav10' },
  { label: 'Медведка 10 шт', weight: 3000, color: '#84CC16', id: 'medvedka10' },
  { label: 'Дрейсена 10 шт', weight: 3000, color: '#0EA5E9', id: 'drayssena10' },
  { label: 'Перловица 10 шт', weight: 3000, color: '#A855F7', id: 'perlovica10' },
  { label: 'Сбитень 10 шт', weight: 3000, color: '#F97316', id: 'sbiten10' },
  { label: 'Золотая монетка 2 шт', weight: 2000, color: '#FBBF24', id: 'coin2' },
  { label: 'Премиум 7 дней', weight: 2000, color: '#6366F1', id: 'prem7' },
  { label: 'Премиум 30 дней', weight: 2000, color: '#14B8A6', id: 'prem30' },
  { label: 'Venga ll 10k', weight: 1, color: '#FFD700', id: 'venga10k' }
]

function pickPrize() {
  const total = prizes.reduce((acc, p) => acc + (p.weight || 1), 0)
  let r = Math.random() * total
  for (let i = 0; i < prizes.length; i++) {
    r -= (prizes[i].weight || 1)
    if (r <= 0) return { index: i, prize: prizes[i] }
  }
  return { index: prizes.length - 1, prize: prizes[prizes.length - 1] }
}

// === Уведомление владельцу в Telegram ===
async function notifyOwner(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text })
    })
  } catch (e) {
    console.log('[notify] ошибка:', e.message)
  }
}

// === API ===
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }))
app.get('/api/prizes', (req, res) => res.json({ ok: true, prizes }))

app.post('/api/spin', (req, res) => {
  if (!BOT_TOKEN && !ALLOW_DEV) {
    return res.status(400).json({ ok: false, error: 'Server not configured: BOT_TOKEN is required' })
  }

  let tgUser = { id: 'dev-user-42', first_name: 'Dev', username: 'dev_user' }
  if (BOT_TOKEN) {
    const ver = verifyInitData(req.body && req.body.initData)
    if (!ver) return res.status(403).json({ ok: false, error: 'initData verification failed' })
    tgUser = ver
  } else if (!ALLOW_DEV) {
    return res.status(403).json({ ok: false, error: 'Not allowed in dev mode' })
  }

  const tgId = String(tgUser.id)
  const user = getUser(tgId, tgUser)
  if (user.spins <= 0) {
    return res.status(400).json({ ok: false, error: 'no_spins', message: 'Нет круток. Задонать можно на DonationAlerts — 100 ₽ = 1 крутка!' })
  }

  user.spins -= 1
  const { index, prize } = pickPrize()
  winsLog.push({ tgId, tgName: '@' + (user.username || user.name), prize: prize.label, at: Date.now() })
  if (winsLog.length > 500) winsLog.shift()

  const msg = `🎰 ${'@' + (user.username || user.name || tgId)} прокрутил рулетку — выпало: «${prize.label}»\n` +
    `Донатов всего: ${user.donated} ₽ | Круток осталось: ${user.spins}`
  notifyOwner(msg)

  res.json({ ok: true, index, prize, spinsLeft: user.spins })
})

// === Админ-панель: /admin?key=ТВОЙ_КЛЮЧ ===
app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send('Доступ запрещён. Добавь в адрес ?key=твой_ключ')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Панель рулетки</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;margin:20px}table{border-collapse:collapse;width:100%;margin:10px 0}td,th{border:1px solid #444;padding:6px 10px;font-size:14px}h2{margin-top:30px}input,button{padding:6px;font-size:14px;margin:2px}</style></head><body>
<h1>🎰 Панель рулетки</h1>
<h2>Начислить крутки вручную</h2>
<input id="uname" placeholder="@username или имя в ТГ"><input id="cnt" type="number" value="1" style="width:60px" placeholder="круток">
<button onclick="addSpins()">Начислить</button><span id="msg"></span>
<h2>Балансы круток</h2><table id="bal"></table>
<h2>Журнал выигрышей</h2><table id="log"></table>
<h2>Нераспознанные донаты (ник не совпал с @username)</h2><table id="pend"></table>
<script>
const KEY = location.search;
async function load(){
  const r = await fetch('/api/admin/data' + KEY); const j = await r.json();
  if(!j.ok){ document.body.innerHTML = 'Ошибка доступа'; return; }
  document.getElementById('bal').innerHTML = '<tr><th>Игрок</th><th>Круток</th><th>Задонатил, ₽</th></tr>' +
    j.users.map(u => '<tr><td>'+u.name+'</td><td>'+u.spins+'</td><td>'+u.donated+'</td></tr>').join('');
  document.getElementById('log').innerHTML = '<tr><th>Время</th><th>Игрок</th><th>Приз</th></tr>' +
    j.wins.map(w => '<tr><td>'+new Date(w.at).toLocaleTimeString()+'</td><td>'+w.tgName+'</td><td>'+w.prize+'</td></tr>').join('');
  document.getElementById('pend').innerHTML = '<tr><th>Ник из доната</th><th>Сумма</th><th>Время</th></tr>' +
    (j.pending.length ? j.pending.map(p => '<tr><td>'+p.nick+'</td><td>'+p.amount+' ₽</td><td>'+new Date(p.at).toLocaleTimeString()+'</td></tr>').join('') : '<tr><td colspan="3">пусто</td></tr>');
}
async function addSpins(){
  const r = await fetch('/api/admin/add-spins' + KEY, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ uname: document.getElementById('uname').value, count: parseInt(document.getElementById('cnt').value)||1 }) });
  const j = await r.json(); document.getElementById('msg').textContent = j.ok ? ' ✅' : ' ❌ ' + (j.error||'');
  load();
}
load(); setInterval(load, 15000);
</script></body></html>`)
})

app.get('/api/admin/data', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'bad_key' })
  res.json({
    ok: true,
    users: Object.entries(users).map(([id, u]) => ({ name: '@' + (u.username || u.name || id), spins: u.spins, donated: u.donated })).sort((a, b) => b.spins - a.spins),
    wins: winsLog.slice().reverse(),
    pending: pendingDonations.slice(-50)
  })
})

app.post('/api/admin/add-spins', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'bad_key' })
  const uname = norm(req.body && req.body.uname)
  const count = parseInt(req.body && req.body.count, 10)
  if (!uname || !(count > 0)) return res.status(400).json({ ok: false, error: 'bad_params' })
  const entry = Object.values(users).find(u => norm(u.username) === uname || norm(u.name) === uname)
  if (!entry) return res.status(404).json({ ok: false, error: 'not_found', message: 'Игрок с таким именем не открывал рулетку' })
  entry.spins += count
  res.json({ ok: true, spins: entry.spins })
})

// === DonationAlerts: подключение и приём донатов ===
app.get('/da/auth', (req, res) => {
  if (!DA_CLIENT_ID) return res.send('Сначала задай DA_CLIENT_ID и DA_CLIENT_SECRET в переменных окружения Render')
  res.redirect(`https://www.donationalerts.com/oauth/authorize?client_id=${DA_CLIENT_ID}&redirect_uri=${encodeURIComponent(DA_REDIRECT_URI)}&response_type=code&scope=oauth-donation-index`)
})

app.get('/da/callback', async (req, res) => {
  try {
    const code = req.query.code
    if (!code) return res.send('Не пришёл код авторизации')
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: DA_CLIENT_ID,
      client_secret: DA_CLIENT_SECRET,
      redirect_uri: DA_REDIRECT_URI,
      code
    })
    const r = await fetch('https://www.donationalerts.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    const j = await r.json()
    if (!j.access_token) return res.send('Ошибка обмена кода: ' + JSON.stringify(j))
    daTokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 }
    res.send('✅ DonationAlerts подключен! Можешь закрыть эту страницу.')
  } catch (e) {
    res.send('Ошибка: ' + e.message)
  }
})

async function getAccessToken() {
  if (!daTokens.access_token) return null
  if (Date.now() < daTokens.expires_at - 60000) return daTokens.access_token
  if (!daTokens.refresh_token) return null
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: DA_CLIENT_ID,
      client_secret: DA_CLIENT_SECRET,
      refresh_token: daTokens.refresh_token
    })
    const r = await fetch('https://www.donationalerts.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    const j = await r.json()
    if (!j.access_token) return null
    daTokens = { access_token: j.access_token, refresh_token: j.refresh_token || daTokens.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 }
    return daTokens.access_token
  } catch (e) {
    return null
  }
}

async function pollDonations() {
  try {
    const token = await getAccessToken()
    if (!token) return
    const r = await fetch('https://www.donationalerts.com/api/v1/alerts/donations?page=1', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!r.ok) { console.log('[DA] ошибка опроса:', r.status); return }
    const j = await r.json()
    const list = j.data || []
    if (!daFirstPollDone) {
      for (const d of list) processedDonations.add(String(d.id))
      daFirstPollDone = true
      console.log('[DA] подключен, старые донаты пропущены')
      return
    }
    for (const d of list) {
      const id = String(d.id)
      if (processedDonations.has(id)) continue
      processedDonations.add(id)
      const nick = norm(d.username || d.name)
      const amount = parseFloat(d.amount_main || d.amount || 0)
      if (!nick || amount <= 0) continue
      const entry = Object.values(users).find(u => norm(u.username) === nick)
      if (entry) {
        const spins = Math.floor(amount / RUB_PER_SPIN)
        if (spins > 0) {
          entry.spins += spins
          entry.donated += amount
          console.log(`[DA] @${nick}: +${spins} круток (донат ${amount} ₽)`)
        }
      } else {
        pendingDonations.push({ nick, amount, at: Date.now() })
        console.log(`[DA] донат без совпадения: ${nick} — ${amount} ₽ (начисли вручную в /admin)`)
      }
    }
  } catch (e) {
    console.log('[DA] исключение:', e.message)
  }
}
setInterval(pollDonations, 20000)
setTimeout(pollDonations, 5000)

app.use('/', express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`[roulette] listening on http://localhost:${PORT}`)
})
