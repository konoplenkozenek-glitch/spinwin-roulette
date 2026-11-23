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
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:8080'
const ALLOW_DEV = (process.env.ALLOW_DEV || 'true').toLowerCase() === 'true'
const SPINS_PER_DAY = parseInt(process.env.SPINS_PER_DAY || '1', 10)

// === In-memory storage (demo) ===
/** @type {Record<string, { date: string, count: number, lastPrize?: any }>} */
const userDailySpins = Object.create(null)

/** Demo prize config. Weight = вероятность (чем больше, тем чаще выпадает). */
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



// === Telegram initData verification ===
/**
 * Verifies initData from Telegram WebApp
 * @param {string} initData
 * @returns {{ok: boolean, userId?: string, data?: Record<string,string>, reason?: string}}
 */
function verifyInitData(initData) {
  try {
    if (!initData || typeof initData !== 'string') {
      return { ok: false, reason: 'empty_init_data' }
    }
    const urlParams = new URLSearchParams(initData)
    const hash = urlParams.get('hash')
    if (!hash) return { ok: false, reason: 'no_hash' }

    // Build data-check-string
    urlParams.delete('hash')
    const pairs = []
    for (const [key, value] of urlParams.entries()) {
      pairs.push(`${key}=${value}`)
    }
    pairs.sort()
    const dataCheckString = pairs.join('\n')

    const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest()
    const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

    if (hmac !== hash) return { ok: false, reason: 'bad_hash' }

    // Extract user id
    const userStr = urlParams.get('user')
    if (!userStr) return { ok: false, reason: 'no_user' }
    const user = JSON.parse(userStr)
    const userId = String(user.id)
    return { ok: true, userId, data: Object.fromEntries(urlParams.entries()) }
  } catch (e) {
    return { ok: false, reason: 'exception' }
  }
}

// === API ===
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() })
})

app.get('/api/prizes', (req, res) => {
  res.json({ ok: true, prizes })
})

app.post('/api/spin', (req, res) => {
  const { initData } = req.body || {}

  if (!BOT_TOKEN && !ALLOW_DEV) {
    return res.status(400).json({ ok: false, error: 'Server not configured: BOT_TOKEN is required' })
  }

  let userId = 'dev-user-42'
  if (BOT_TOKEN) {
    const ver = verifyInitData(initData)
   // if (!ver.ok) return res.status(403).json({ ok: false, error: 'initData verification failed', reason: ver.reason })
    userId = ver.userId
  } else if (!ALLOW_DEV) {
    return res.status(403).json({ ok: false, error: 'Not allowed in dev mode' })
  }

  // Daily limit
  const today = new Date().toISOString().slice(0, 10)
  const rec = userDailySpins[userId] || { date: today, count: 0 }
  if (rec.date !== today) {
    rec.date = today
    rec.count = 0
  }
  if (rec.count >= SPINS_PER_DAY) {
    return res.status(429).json({ ok: false, error: 'daily_limit', message: `Лимит ${SPINS_PER_DAY} попыток в сутки исчерпан` })
  }

  // Weighted random choice
  const totalWeight = prizes.reduce((acc, p) => acc + (p.weight || 1), 0)
  let r = Math.random() * totalWeight
  let idx = 0
  for (let i = 0; i < prizes.length; i++) {
    r -= (prizes[i].weight || 1)
    if (r <= 0) { idx = i; break }
  }
  const prize = prizes[idx]

  rec.count += 1
  rec.lastPrize = { id: prize.id, label: prize.label, at: Date.now() }
  userDailySpins[userId] = rec

  res.json({ ok: true, index: idx, prize })
})

// serve static files (frontend) from /public
app.use('/', express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`[telegram-roulette-miniapp] listening on http://localhost:${PORT}`)
})
