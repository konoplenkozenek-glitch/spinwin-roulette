import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

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
const RUB_PER_SPIN = parseFloat(process.env.RUB_PER_SPIN || '100')
const DA_CLIENT_ID = process.env.DA_CLIENT_ID || ''
const DA_CLIENT_SECRET = process.env.DA_CLIENT_SECRET || ''
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '')
const DA_REDIRECT_URI = process.env.DA_REDIRECT_URI || `${PUBLIC_URL}/da/callback`

// === Supabase ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
)

// === Storage ===
const users = Object.create(null)
const winsLog = []
const pendingDonations = []
const processedDonations = new Set()
let daFirstPollDone = false
let daTokens = { access_token: null, refresh_token: null, expires_at: 0 }
let lastDonation = null // последний распознанный донат (для админки)

const norm = s => String(s || '').trim().toLowerCase().replace(/^@/, '')

async function syncUserToDB(tgId, user) {
  if (!supabase) return
  try {
    await supabase.from('roulette_users').upsert({
      tg_id: tgId,
      name: user.name,
      username: user.username,
      game_nick: user.gameNick,
      spins: user.spins,
      donated: user.donated
    })
  } catch (e) { console.error('Sync error:', e.message) }
}

async function syncWinToDB(tgId, tgName, gameNick, prize) {
  if (!supabase) return
  try {
    await supabase.from('roulette_history').insert([{
      user_id: tgId,
      username: tgName,
      prize: prize
    }])
  } catch (e) { console.error('Win log error:', e.message) }
}

// === Токен DonationAlerts: загрузка и сохранение в Supabase ===
async function loadDaTokens() {
  if (!supabase) return
  try {
    const { data, error } = await supabase
      .from('da_tokens')
      .select('*')
      .eq('id', 1)
      .limit(1)
    if (error) throw error
    if (data && data.length) {
      daTokens = {
        access_token: data[0].access_token,
        refresh_token: data[0].refresh_token,
        expires_at: data[0].expires_at || 0
      }
      console.log('[DA] токен загружен из БД')
    } else {
      console.log('[DA] токена в БД нет — нужна авторизация /da/auth')
    }
  } catch (e) {
    console.error('[DA] ошибка загрузки токена:', e.message)
  }
}

async function saveDaTokens() {
  if (!supabase) return
  try {
    const { error } = await supabase
      .from('da_tokens')
      .upsert({
        id: 1,
        access_token: daTokens.access_token,
        refresh_token: daTokens.refresh_token,
        expires_at: daTokens.expires_at
      })
    if (error) throw error
    console.log('[DA] токен сохранён в БД')
  } catch (e) {
    console.error('[DA] ошибка сохранения токена:', e.message)
  }
}

async function loadDataFromDB() {
  if (!supabase) return
  try {
    // 1. Загружаем пользователей
    const { data: dbUsers } = await supabase.from('roulette_users').select('*')
    if (dbUsers) {
      dbUsers.forEach(u => {
        users[u.tg_id] = {
          name: u.name, username: u.username, gameNick: u.game_nick,
          spins: u.spins, donated: u.donated
        }
      })
    }

    // 2. Загружаем историю для админки (последние 500)
    const { data: dbWins } = await supabase
      .from('roulette_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500)

    if (dbWins) {
      dbWins.reverse().forEach(w => {
        winsLog.push({
          tgId: String(w.user_id),
          tgName: w.username,
          gameNick: '',
          prize: w.prize,
          at: new Date(w.created_at).getTime()
        })
      })
    }
    console.log('✅ Данные и история загружены из Supabase')
  } catch (e) { console.error('Ошибка загрузки:', e.message) }
}
loadDataFromDB()
loadDaTokens()

function getUser(tgId, initDataUser) {
  if (!users[tgId]) {
    users[tgId] = {
      name: (initDataUser && initDataUser.first_name) || '',
      username: (initDataUser && initDataUser.username) || '',
      gameNick: '',
      spins: 0,
      donated: 0
    }
  }
  return users[tgId]
}

// === Telegram verify ===
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
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    const hmac = crypto.createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex')
    if (hmac !== hash) return null
    const userStr = urlParams.get('user')
    if (!userStr) return null
    return JSON.parse(userStr)
  } catch (e) { return null }
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
  { label: 'Премиум 30 дней', weight: 1000, color: '#14B8A6', id: 'prem30' },
  { label: 'Venga ll 10k', weight: 1, color: '#FFD700', id: 'venga10k' }
]

// === ИВЕНТ: временные шансы призов ===
// Чтобы запустить ивент, впиши множитель нужному призу, например:
// const PRIZE_BOOST = { prem30: 10 }  → «Премиум 30 дней» выпадает в 10 раз чаще
// const PRIZE_BOOST = { bait5: 0.5 }  → «Любая наживка 5 шт» в 2 раза реже
// Чтобы закончить ивент — верни строку к виду const PRIZE_BOOST = {}
const PRIZE_BOOST = {}
if (PRIZE_BOOST && Object.keys(PRIZE_BOOST).length) {
  prizes.forEach(p => {
    if (PRIZE_BOOST[p.id]) p.weight = Math.max(1, Math.round(p.weight * PRIZE_BOOST[p.id]))
  })
  console.log('🎉 Ивент активен:', JSON.stringify(PRIZE_BOOST))
}

function pickPrize() {
  const total = prizes.reduce((acc, p) => acc + (p.weight || 1), 0)
  let r = Math.random() * total
  for (let i = 0; i < prizes.length; i++) {
    r -= (prizes[i].weight || 1)
    if (r <= 0) return { index: i, prize: prizes[i] }
  }
  return { index: prizes.length - 1, prize: prizes[prizes.length - 1] }
}

async function notifyOwner(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text })
    })
  } catch (e) { }
}

function findUserByDonation(nick, message) {
  let entry = Object.values(users).find(u => norm(u.username) === nick || norm(u.name) === nick)
  if (entry) return entry
  const text = `${nick} ${message || ''}`.toLowerCase()
  const m = text.match(/@?([a-z0-9_]{4,32})/)
  if (m) {
    const cand = m[1]
    entry = Object.values(users).find(u => norm(u.username) === cand || norm(u.name) === cand)
    if (entry) return entry
  }
  for (const u of Object.values(users)) {
    const un = norm(u.username)
    if (un && un.length >= 4 && text.includes(un)) return u
    const nm = norm(u.name)
    if (nm && nm.length >= 4 && text.includes(nm)) return u
  }
  return null
}

// === API ===
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }))
app.get('/api/prizes', (req, res) => res.json({ ok: true, prizes }))

app.post('/api/me', async (req, res) => {
  let tgUser = null
  if (BOT_TOKEN) tgUser = verifyInitData(req.body && req.body.initData)
  if (!tgUser && ALLOW_DEV) tgUser = { id: 'dev-user-42', first_name: 'Dev', username: 'dev_user' }
  if (!tgUser) return res.status(403).json({ ok: false, error: 'auth_failed' })

  const tgId = String(tgUser.id)
  const user = getUser(tgId, tgUser)

  const gameNick = String((req.body && req.body.gameNick) || '').trim()
  if (gameNick && !user.gameNick) {
    user.gameNick = gameNick.slice(0, 40)
    await syncUserToDB(tgId, user)
  }

  res.json({
    ok: true, spins: user.spins, donated: user.donated,
    name: '@' + (user.username || user.name || tgId),
    gameNick: user.gameNick || ''
  })
})

app.post('/api/spin', async (req, res) => {
  if (!BOT_TOKEN && !ALLOW_DEV) return res.status(400).json({ ok: false, error: 'Server not configured' })
  let tgUser = null
  if (BOT_TOKEN && !ALLOW_DEV) {
    const ver = verifyInitData(req.body && req.body.initData)
    if (!ver) return res.status(403).json({ ok: false, error: 'initData verification failed' })
    tgUser = ver
  } else if (BOT_TOKEN && ALLOW_DEV) {
    tgUser = verifyInitData(req.body && req.body.initData) || { id: 'dev-user-42', first_name: 'Dev', username: 'dev_user' }
  } else if (!ALLOW_DEV) {
    return res.status(403).json({ ok: false, error: 'Not allowed in dev mode' })
  } else {
    tgUser = { id: 'dev-user-42', first_name: 'Dev', username: 'dev_user' }
  }

  const tgId = String(tgUser.id)
  const user = getUser(tgId, tgUser)
  if (user.spins <= 0) {
    return res.status(400).json({ ok: false, error: 'no_spins', message: 'Нет круток. Задонать на DonationAlerts — 100 ₽ = 1 крутка!' })
  }

  user.spins -= 1
  const { index, prize } = pickPrize()

  const tgName = '@' + (user.username || user.name)
  winsLog.push({ tgId, tgName, gameNick: user.gameNick || '', prize: prize.label, at: Date.now() })
  if (winsLog.length > 500) winsLog.shift()

  await syncUserToDB(tgId, user)
  await syncWinToDB(tgId, tgName, user.gameNick, prize.label)

  const msg = `🎰 ${tgName}` + (user.gameNick ? ` (игровой ник: ${user.gameNick})` : '') + `\nВыпало: «${prize.label}»\nКруток осталось: ${user.spins}`
  notifyOwner(msg)

  res.json({ ok: true, index, prize, spinsLeft: user.spins })
})

// === Админка ===
app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send('Доступ запрещён. Добавь в адрес ?key=твой_ключ')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Панель рулетки</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;margin:20px}table{border-collapse:collapse;width:100%;margin:10px 0}td,th{border:1px solid #444;padding:6px 10px;font-size:14px}h2{margin-top:30px}input,button{padding:6px;font-size:14px;margin:2px}.danger{background:#7f1d1d;color:#fff;border:1px solid #ef4444;padding:8px 14px;border-radius:6px;cursor:pointer}.more{background:#1f3a5f;color:#fff;border:1px solid #3b82f6;padding:8px 14px;border-radius:6px;cursor:pointer}.tops{display:flex;gap:20px;flex-wrap:wrap}.topcard{flex:1;min-width:280px;background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px}.topcard h3{margin:0 0 8px;font-size:15px;color:#FFD700}.topcard ol{margin:0;padding-left:22px}.topcard li{margin:4px 0}.lastdon{background:#1a2a1a;border:1px solid #3ddc84;border-radius:8px;padding:12px;margin:10px 0;font-size:14px}.reset{background:#7f1d1d;color:#fff;border:1px solid #ef4444;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px}</style></head><body>
<h1>🎰 Панель рулетки</h1>
<h2>Начислить крутки вручную</h2>
<input id="uname" placeholder="@username или имя в ТГ"><input id="cnt" type="number" value="1" style="width:60px" placeholder="круток">
<button onclick="addSpins()">Начислить</button><span id="msg"></span>
<h2>Последний донат</h2><div class="lastdon" id="lastdon">— пока донатов с последнего рестарта не было —</div>
<h2>Балансы круток</h2><table id="bal"></table>
<div class="tops">
  <div class="topcard"><h3>💸 Топ-5 по донатам</h3><ol id="topDon"></ol></div>
  <div class="topcard"><h3>🎰 Топ-5 по круткам</h3><ol id="topSpins"></ol></div>
</div>
<h2>Журнал выигрышей</h2><table id="log"></table>
<button class="more" id="moreBtn" style="display:none" onclick="showMore()">Показать ещё 30</button>
<button class="danger" onclick="clearHistory()">🧹 Очистить журнал выигрышей</button><span id="clrmsg"></span>
<h2>Нераспознанные донаты</h2><table id="pend"></table>
<script>
const KEY = location.search;
let allWins = [];
let shownCount = 30;
async function load(){
  const r = await fetch('/api/admin/data' + KEY); const j = await r.json();
  if(!j.ok){ document.body.innerHTML = 'Ошибка доступа'; return; }
  // Последний донат
  const ld = document.getElementById('lastdon');
  ld.innerHTML = j.lastDonation
    ? '💰 <b>'+j.lastDonation.amount+' ₽</b> от «'+j.lastDonation.nick+'» → <b>'+j.lastDonation.user+'</b> · +'+j.lastDonation.spins+' круток · '+new Date(j.lastDonation.at).toLocaleTimeString()
    : '— пока донатов с последнего рестарта не было —';
  // Балансы
  document.getElementById('bal').innerHTML = '<tr><th>Игрок (ТГ)</th><th>Игровой ник</th><th>Круток</th><th>Задонатил, ₽</th><th></th></tr>' +
    j.users.map(u => '<tr><td>'+u.name+'</td><td>'+(u.gameNick||'—')+'</td><td>'+u.spins+'</td><td>'+u.donated+'</td><td>'+(u.uname ? '<button class="reset" onclick="resetSpins(\\''+u.uname+'\\')">Сбросить</button>' : '')+'</td></tr>').join('');
  // Топы
  const fmt = n => Math.round(n*100)/100;
  const topD = j.users.slice().sort((a,b)=>b.donated-a.donated).filter(u=>u.donated>0).slice(0,5);
  const topS = j.users.slice().sort((a,b)=>b.spins-a.spins).filter(u=>u.spins>0).slice(0,5);
  document.getElementById('topDon').innerHTML = topD.length ? topD.map(u=>'<li>'+u.name+' — <b>'+fmt(u.donated)+' ₽</b></li>').join('') : '<li>пока пусто</li>';
  document.getElementById('topSpins').innerHTML = topS.length ? topS.map(u=>'<li>'+u.name+' — <b>'+u.spins+'</b></li>').join('') : '<li>пока пусто</li>';
  // Журнал
  allWins = j.wins;
  renderLog();
  // Нераспознанные
  document.getElementById('pend').innerHTML = '<tr><th>Ник из доната</th><th>Сообщение</th><th>Сумма</th><th></th></tr>' +
    (j.pending.length ? j.pending.map(p => '<tr><td>'+p.nick+'</td><td>'+(p.message||'—')+'</td><td>'+p.amount+' ₽</td><td><button onclick="assign('+p.id+')">Начислить</button></td></tr>').join('') : '<tr><td colspan="4">пусто</td></tr>');
}
function renderLog(){
  document.getElementById('log').innerHTML = '<tr><th>Время</th><th>Игрок</th><th>Игровой ник</th><th>Приз</th></tr>' +
    allWins.slice(0, shownCount).map(w => '<tr><td>'+new Date(w.at).toLocaleTimeString()+'</td><td>'+w.tgName+'</td><td>'+(w.gameNick||'—')+'</td><td>'+w.prize+'</td></tr>').join('');
  const btn = document.getElementById('moreBtn');
  if (allWins.length > shownCount) { btn.style.display = 'inline-block'; btn.textContent = 'Показать ещё 30 (осталось ' + (allWins.length - shownCount) + ')'; }
  else { btn.style.display = 'none'; }
}
function showMore(){ shownCount += 30; renderLog(); }
async function addSpins(){
  const r = await fetch('/api/admin/add-spins' + KEY, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ uname: document.getElementById('uname').value, count: parseInt(document.getElementById('cnt').value)||1 }) });
  const j = await r.json(); document.getElementById('msg').textContent = j.ok ? ' ✅' : ' ❌ ' + (j.error||'');
  load();
}
async function resetSpins(uname){
  if (!confirm('Обнулить крутки у ' + uname + '?')) return;
  const r = await fetch('/api/admin/reset-spins' + KEY, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ uname: uname }) });
  const j = await r.json(); if (!j.ok) alert('Ошибка: ' + (j.error || 'не найдено'));
  load();
}
async function clearHistory(){
  if (!confirm('Точно стереть ВЕСЬ журнал выигрышей? Действие необратимо.')) return;
  shownCount = 30;
  const r = await fetch('/api/admin/clear-history' + KEY, { method:'POST' });
  const j = await r.json();
  document.getElementById('clrmsg').textContent = j.ok ? ' ✅ Журнал очищен' : ' ❌ ' + (j.error||'');
  load();
}
async function assign(id){
  const uname = prompt('Ник игрока в ТГ (без @):');
  if (!uname) return;
  const r = await fetch('/api/admin/assign-pending' + KEY, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id: id, uname: uname }) });
  const j = await r.json(); if (!j.ok) alert('Ошибка: ' + (j.error || 'не найдено'));
  load();
}
load(); setInterval(load, 15000);
</script></body></html>`)
})

app.get('/api/admin/data', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'bad_key' })
  res.json({
    ok: true,
    users: Object.entries(users).map(([id, u]) => ({ name: '@' + (u.username || u.name || id), uname: (u.username || u.name || '').trim(), gameNick: u.gameNick, spins: u.spins, donated: u.donated })).sort((a, b) => b.spins - a.spins),
    wins: winsLog.slice().reverse(),
    pending: pendingDonations.slice(-100),
    lastDonation
  })
})

app.post('/api/admin/add-spins', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'bad_key' })
  const uname = norm(req.body && req.body.uname)
  const count = parseInt(req.body && req.body.count, 10)
  if (!uname || !(count > 0)) return res.status(400).json({ ok: false, error: 'bad_params' })

  const entryKey = Object.keys(users).find(k => norm(users[k].username) === uname || norm(users[k].name) === uname)
  if (!entryKey) return res.status(404).json({ ok: false, error: 'not_found', message: 'Игрок не найден' })

  users[entryKey].spins += count
  await syncUserToDB(entryKey, users[entryKey])

  res.json({ ok: true, spins: users[entryKey].spins })
})

app.post('/api/admin/reset-spins', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'bad_key' })
  const uname = norm(req.body && req.body.uname)
  if (!uname) return res.status(400).json({ ok: false, error: 'bad_params' })

  const entryKey = Object.keys(users).find(k => norm(users[k].username) === uname || norm(users[k].name) === uname)
  if (!entryKey) return res.status(404).json({ ok: false, error: 'not_found', message: 'Игрок не найден' })

  users[entryKey].spins = 0
  await syncUserToDB(entryKey, users[entryKey])

  res.json({ ok: true, spins: 0 })
})

app.post('/api/admin/assign-pending', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'bad_key' })
  const id = parseInt(req.body && req.body.id, 10)
  const uname = norm(req.body && req.body.uname)
  const entry = pendingDonations.find(p => p.id === id)
  if (!entry) return res.status(404).json({ ok: false, error: 'donation_not_found' })

  const entryKey = Object.keys(users).find(k => norm(users[k].username) === uname || norm(users[k].name) === uname)
  if (!entryKey) return res.status(404).json({ ok: false, error: 'user_not_found', message: 'Игрок не найден' })

  const spins = Math.floor(entry.amount / RUB_PER_SPIN)
  users[entryKey].spins += spins
  users[entryKey].donated += entry.amount
  pendingDonations.splice(pendingDonations.indexOf(entry), 1)

  await syncUserToDB(entryKey, users[entryKey])

  res.json({ ok: true, spins: users[entryKey].spins, credited: spins })
})

app.post('/api/admin/clear-history', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'bad_key' })
  winsLog.length = 0
  if (supabase) {
    try {
      await supabase.from('roulette_history').delete().gte('id', 0)
    } catch (e) {
      console.error('Clear history error:', e.message)
      return res.status(500).json({ ok: false, error: 'db_error' })
    }
  }
  res.json({ ok: true })
})

// === DonationAlerts ===
app.get('/da/auth', (req, res) => {
  if (!DA_CLIENT_ID) return res.send('Задай DA_CLIENT_ID и DA_CLIENT_SECRET')
  res.redirect(`https://www.donationalerts.com/oauth/authorize?client_id=${DA_CLIENT_ID}&redirect_uri=${encodeURIComponent(DA_REDIRECT_URI)}&response_type=code&scope=oauth-donation-index`)
})

app.get('/da/callback', async (req, res) => {
  try {
    const code = req.query.code
    if (!code) return res.send('Не пришёл код авторизации')
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: DA_CLIENT_ID, client_secret: DA_CLIENT_SECRET, redirect_uri: DA_REDIRECT_URI, code })
    const r = await fetch('https://www.donationalerts.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    const j = await r.json()
    if (!j.access_token) return res.send('Ошибка обмена кода: ' + JSON.stringify(j))
    daTokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 }
    await saveDaTokens()
    res.send('✅ DonationAlerts подключен!')
  } catch (e) { res.send('Ошибка: ' + e.message) }
})

async function getAccessToken() {
  if (!daTokens.access_token) return null
  if (Date.now() < daTokens.expires_at - 60000) return daTokens.access_token
  if (!daTokens.refresh_token) return null
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: DA_CLIENT_ID, client_secret: DA_CLIENT_SECRET, refresh_token: daTokens.refresh_token })
    const r = await fetch('https://www.donationalerts.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    const j = await r.json()
    if (!j.access_token) return null
    daTokens = { access_token: j.access_token, refresh_token: j.refresh_token || daTokens.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 }
    await saveDaTokens()
    return daTokens.access_token
  } catch (e) { return null }
}

async function pollDonations() {
  try {
    const token = await getAccessToken()
    if (!token) return
    const r = await fetch('https://www.donationalerts.com/api/v1/alerts/donations?page=1', { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return
    const j = await r.json()
    const list = j.data || []
    const cutoff = Date.now() - 10 * 60 * 1000

    if (!daFirstPollDone) {
      for (const d of list) { if ((new Date(d.created_at).getTime() || 0) < cutoff) processedDonations.add(String(d.id)) }
      daFirstPollDone = true
    }

    for (const d of list) {
      const id = String(d.id)
      if (processedDonations.has(id)) continue
      processedDonations.add(id)
      const nick = d.username || d.name || ''
      const message = d.message || ''
      const amount = parseFloat(d.amount_main || d.amount || 0)
      if (amount <= 0) continue

      const user = findUserByDonation(norm(nick), message)
      if (user) {
        const spins = Math.floor(amount / RUB_PER_SPIN)
        if (spins > 0) {
          user.spins += spins
          user.donated += amount

          const userKey = Object.keys(users).find(k => users[k] === user)
          if(userKey) await syncUserToDB(userKey, user)

          lastDonation = {
            nick: nick || '(без имени)',
            user: '@' + (user.username || user.name),
            amount,
            spins,
            at: Date.now()
          }

          notifyOwner(`💰 Донат ${amount} ₽ от «${nick}» → @${user.username || user.name}: +${spins} круток`)
        } else {
          pendingDonations.push({ id: Date.now() + Math.floor(Math.random() * 1000), nick: nick || '(без имени)', message, amount, at: Date.now() })
        }
      } else {
        pendingDonations.push({ id: Date.now() + Math.floor(Math.random() * 1000), nick: nick || '(без имени)', message, amount, at: Date.now() })
        notifyOwner(`⚠️ Донат ${amount} ₽ от «${nick || 'без имени'}» не распознан.`)
      }
    }
  } catch (e) { }
}
setInterval(pollDonations, 20000)
setTimeout(pollDonations, 5000)

app.use('/', express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`[roulette] listening on http://localhost:${PORT}`)
})
