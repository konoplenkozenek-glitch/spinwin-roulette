// ====== Золотая Удача — сервер ======
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DA_ACCESS_TOKEN = process.env.DA_ACCESS_TOKEN || '';

// ====== НАСТРОЙКИ ПАКЕТОВ, ПРИЗОВ И ЦЕЛИ ======
const PROGRESS_GOAL = 10000;   // цель прогресс-бара, ₽
const GOAL_BONUS_SPINS = 5;    // сколько взрывов за достижение цели

const PACKAGES = [
  { amount: 100,  spins: 1 },
  { amount: 300,  spins: 4 },
  { amount: 1000, spins: 13 }
];

// NB: названия призов поправь под свои реальные награды
const PRIZES = [
  { label: 'Пусто 💨',     color: '#888888', weight: 30 },
  { label: '+1 взрыв 💣',  color: '#3ddc84', weight: 20, bonusSpins: 1 },
  { label: '+2 взрыва 💣💣', color: '#3ddc84', weight: 10, bonusSpins: 2 },
  { label: 'Снасть 🔧',    color: '#4fc3f7', weight: 12 },
  { label: 'Наживка x5 🦗', color: '#4fc3f7', weight: 8 },
  { label: 'Супер-приз 🏆', color: '#FFD700', weight: 5 }
];
// ==============================================

// ====== БАЗА ======
const db = new Database('roulette.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  chat_id TEXT,
  game_nick TEXT,
  spins INTEGER DEFAULT 0,
  donated REAL DEFAULT 0,
  goal_bonus INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  da_id TEXT UNIQUE,
  amount REAL,
  message TEXT,
  username TEXT,
  telegram_id TEXT,
  spins_added INTEGER DEFAULT 0,
  recognized INTEGER DEFAULT 0,
  ts INTEGER
);
CREATE TABLE IF NOT EXISTS promos (
  code TEXT PRIMARY KEY,
  spins INTEGER DEFAULT 1,
  used_by TEXT,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS wins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT,
  prize TEXT,
  ts INTEGER
);
`);

// если база уже существовала со старой схемой — добавляем колонку
try { db.exec('ALTER TABLE users ADD COLUMN goal_bonus INTEGER DEFAULT 0'); } catch (e) {}

// ====== ХЕЛПЕРЫ ======
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => k + '=' + v).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calc !== hash) return null;
    return JSON.parse(params.get('user') || '{}');
  } catch (e) {
    return null;
  }
}

function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
}

function ensureUser(tgUser, chatId) {
  const id = String(tgUser.id);
  let u = getUser(id);
  if (!u) {
    db.prepare(`INSERT INTO users (telegram_id, username, chat_id, game_nick, spins, donated, goal_bonus, created_at)
      VALUES (?, ?, ?, NULL, 0, 0, 0, ?)`)
      .run(id, tgUser.username || (tgUser.first_name || ''), chatId || null, Date.now());
    u = getUser(id);
  } else if (chatId && !u.chat_id) {
    db.prepare('UPDATE users SET chat_id = ? WHERE telegram_id = ?').run(String(chatId), id);
    u = getUser(id);
  }
  return u;
}

function syncUserToDB(u) {
  db.prepare('UPDATE users SET spins = ?, donated = ?, game_nick = ?, username = ?, goal_bonus = ? WHERE telegram_id = ?')
    .run(u.spins, u.donated, u.game_nick, u.username, u.goal_bonus || 0, String(u.telegram_id));
}

// Сумма доната -> крутки (по пакетам, снизу вверх)
function spinsForAmount(amount) {
  let remaining = amount;
  let total = 0;
  const sorted = [...PACKAGES].sort((a, b) => a.amount - b.amount);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (remaining >= p.amount) {
      total += p.spins;
      remaining -= p.amount;
    }
  }
  return total;
}

// Бонус за достижение цели 10000 ₽ (один раз на игрока)
function grantGoalBonus(u) {
  if (u.donated >= PROGRESS_GOAL && !u.goal_bonus) {
    u.goal_bonus = 1;
    u.spins += GOAL_BONUS_SPINS;
    sendTelegramMessage(u.chat_id,
      `🎉 Цель ${PROGRESS_GOAL.toLocaleString('ru-RU')} ₽ достигнута! Тебе начислено +${GOAL_BONUS_SPINS} взрывов в подарок! 💣`);
    return true;
  }
  return false;
}

function pickPrize() {
  const totalWeight = PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * totalWeight;
  let index = 0;
  for (let i = 0; i < PRIZES.length; i++) {
    r -= PRIZES[i].weight;
    if (r <= 0) { index = i; break; }
  }
  return index;
}

async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) { /* игнорируем */ }
}

// ====== API МИНИ-АППА ======
app.get('/api/prizes', (req, res) => {
  res.json({ ok: true, prizes: PRIZES.map(p => ({ label: p.label, color: p.color })) });
});

app.post('/api/me', async (req, res) => {
  const tgUser = verifyInitData(req.body.initData);
  if (!tgUser) return res.json({ ok: false, error: 'auth' });
  const u = ensureUser(tgUser, null);

  if (req.body.gameNick) {
    u.game_nick = String(req.body.gameNick).slice(0, 40);
    syncUserToDB(u);
  }

  const rankRow = db.prepare(
    'SELECT COUNT(*) + 1 AS rank FROM users WHERE donated > ?'
  ).get(u.donated);
  const totalRow = db.prepare('SELECT COUNT(*) AS total FROM users WHERE donated > 0').get();

  res.json({
    ok: true,
    spins: u.spins,
    donated: u.donated,
    gameNick: u.game_nick,
    rank: rankRow.rank,
    totalPlayers: totalRow.total
  });
});

app.post('/api/spin', (req, res) => {
  const tgUser = verifyInitData(req.body.initData);
  if (!tgUser) return res.json({ ok: false, error: 'auth', message: 'Ошибка авторизации' });
  const u = ensureUser(tgUser, null);

  if (u.spins <= 0) {
    return res.json({ ok: false, error: 'no_spins', message: 'Нет взрывов! Задонать и крути 💣' });
  }

  u.spins -= 1;
  const index = pickPrize();
  const prize = PRIZES[index];
  if (prize.bonusSpins) u.spins += prize.bonusSpins;
  syncUserToDB(u);

  db.prepare('INSERT INTO wins (telegram_id, prize, ts) VALUES (?, ?, ?)')
    .run(String(u.telegram_id), prize.label, Date.now());

  res.json({ ok: true, index, prize: { label: prize.label, color: prize.color }, spinsLeft: u.spins });
});

app.post('/api/redeem-promo', (req, res) => {
  const tgUser = verifyInitData(req.body.initData);
  if (!tgUser) return res.json({ ok: false, error: 'auth' });
  const u = ensureUser(tgUser, null);

  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.json({ ok: false, error: 'not_found' });

  const promo = db.prepare('SELECT * FROM promos WHERE code = ?').get(code);
  if (!promo) return res.json({ ok: false, error: 'not_found' });
  if (promo.used_by) return res.json({ ok: false, error: 'used' });

  db.prepare('UPDATE promos SET used_by = ?, used_at = ? WHERE code = ?')
    .run(String(u.telegram_id), Date.now(), code);
  u.spins += promo.spins;
  syncUserToDB(u);

  res.json({ ok: true, spins: u.spins });
});

// ====== АДМИНКА ======
function checkAdmin(req) {
  const key = req.query.key || (req.body && req.body.key) || '';
  return ADMIN_KEY && key === ADMIN_KEY;
}

app.get('/admin', (req, res) => {
  if (!checkAdmin(req)) return res.status(403).send('Неверный ключ админа');
  res.send(getAdminHtml());
});

app.get('/api/admin/data', (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const users = db.prepare('SELECT * FROM users ORDER BY donated DESC, spins DESC').all();
  const unrecognized = db.prepare(
    'SELECT * FROM donations WHERE recognized = 0 ORDER BY ts DESC LIMIT 20'
  ).all();
  const lastDonation = db.prepare(
    'SELECT * FROM donations ORDER BY ts DESC LIMIT 1'
  ).get();
  const promos = db.prepare('SELECT * FROM promos ORDER BY rowid DESC LIMIT 20').all();
  const totalDonated = db.prepare('SELECT SUM(donated) AS s FROM users').get().s || 0;
  res.json({
    ok: true,
    users: users.map(u => ({
      telegram_id: u.telegram_id, username: u.username, game_nick: u.game_nick,
      spins: u.spins, donated: u.donated, goal_bonus: u.goal_bonus
    })),
    unrecognized,
    lastDonation,
    promos,
    totalDonated
  });
});

app.post('/api/admin/add-spins', (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const u = getUser(req.body.telegramId);
  if (!u) return res.json({ ok: false, error: 'no_user' });
  u.spins += parseInt(req.body.amount, 10) || 0;
  syncUserToDB(u);
  res.json({ ok: true, spins: u.spins });
});

app.post('/api/admin/create-promo', (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 12);
  if (!code) return res.json({ ok: false });
  const spins = parseInt(req.body.spins, 10) || 1;
  try {
    db.prepare('INSERT INTO promos (code, spins) VALUES (?, ?)').run(code, spins);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'exists' });
  }
});

app.post('/api/admin/resolve-donation', (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const d = db.prepare('SELECT * FROM donations WHERE id = ?').get(req.body.donationId);
  if (!d) return res.json({ ok: false, error: 'no_donation' });
  const u = getUser(req.body.telegramId);
  if (!u) return res.json({ ok: false, error: 'no_user' });
  const spins = spinsForAmount(d.amount);
  u.spins += spins;
  u.donated += d.amount;
  grantGoalBonus(u);
  syncUserToDB(u);
  db.prepare('UPDATE donations SET recognized = 1, telegram_id = ?, spins_added = ? WHERE id = ?')
    .run(String(u.telegram_id), spins, d.id);
  sendTelegramMessage(u.chat_id, `💣 Админ зачислил тебе ${spins} взрывов за донат ${d.amount} ₽!`);
  res.json({ ok: true, spins });
});

app.get('/api/admin/test-spins', (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const samples = [100, 300, 500, 1000, 1300, 2000, 10000];
  res.json({ ok: true, packages: PACKAGES, samples: samples.map(a => ({ amount: a, spins: spinsForAmount(a) })) });
});

// ====== ПОЛУЧЕНИЕ ДОНАТОВ С DONATIONALERTS ======
let lastDaId = null;

async function pollDonations() {
  if (!DA_ACCESS_TOKEN) return;
  try {
    const r = await fetch('https://www.donationalerts.com/api/v1/donations?sort=id_desc&limit=10', {
      headers: { Authorization: 'Bearer ' + DA_ACCESS_TOKEN }
    });
    const j = await r.json();
    const list = (j.data || []).slice().reverse(); // от старых к новым
    for (const d of list) {
      if (lastDaId !== null && d.id <= lastDaId) continue;
      lastDaId = d.id;

      const amount = parseFloat(d.amount) || 0;
      const message = d.message || '';
      const username = d.username || '';

      // ищем игрока по @нику в сообщении или по username
      let user = null;
      const nickMatch = message.match(/@([A-Za-z0-9_]{3,32})/);
      if (nickMatch) {
        user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(nickMatch[1]);
      }
      if (!user && username) {
        user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
      }

      if (user && amount >= 100) {
        const spins = spinsForAmount(amount);
        user.spins += spins;
        user.donated += amount;
        grantGoalBonus(user);
        syncUserToDB(user);
        db.prepare(`INSERT OR IGNORE INTO donations (da_id, amount, message, username, telegram_id, spins_added, recognized, ts)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
          .run(String(d.id), amount, message, username, String(user.telegram_id), spins, Date.now());
        sendTelegramMessage(user.chat_id,
          `💥 Спасибо за донат ${amount} ₽! Зачислено ${spins} взрывов.\nОткрой игру и крути! 🎰`);
      } else {
        db.prepare(`INSERT OR IGNORE INTO donations (da_id, amount, message, username, telegram_id, spins_added, recognized, ts)
          VALUES (?, ?, ?, ?, NULL, 0, 0, ?)`)
          .run(String(d.id), amount, message, username, Date.now());
      }
    }
  } catch (e) { /* повторим на следующем опросе */ }
}

// запоминаем последний id доната при старте, чтобы не зачислять старые повторно
async function initDaPointer() {
  if (!DA_ACCESS_TOKEN) return;
  try {
    const r = await fetch('https://www.donationalerts.com/api/v1/donations?sort=id_desc&limit=1', {
      headers: { Authorization: 'Bearer ' + DA_ACCESS_TOKEN }
    });
    const j = await r.json();
    if (j.data && j.data.length) lastDaId = j.data[0].id;
  } catch (e) { /* стартуем с null */ }
}
initDaPointer();
setInterval(pollDonations, 30000); // каждые 30 секунд

// ====== СТРАНИЦА АДМИНКИ ======
function getAdminHtml() {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Админка — Золотая Удача</title>
<style>
body{font-family:sans-serif;background:#111;color:#eee;padding:16px;max-width:900px;margin:0 auto}
h1{color:#FFD700;font-size:20px}
h2{color:#FFD700;font-size:16px;margin-top:20px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border:1px solid #333;padding:6px 8px;text-align:left}
th{background:#222;color:#FFD700}
button{background:#FFD700;border:none;padding:6px 10px;border-radius:8px;font-weight:bold;cursor:pointer}
.muted{color:#888;font-size:12px}
</style></head><body>
<h1>🛠 Админка — Золотая Удача</h1>
<div class="muted" id="stats"></div>
<h2>💵 Последний донат</h2><div id="lastDonation">—</div>
<h2>⚠️ Нераспознанные донаты</h2><div id="unrecognized">—</div>
<h2>👥 Игроки</h2><div id="users">—</div>
<h2>🎟 Промокоды</h2>
<div><input id="promoCode" placeholder="КОД" style="padding:6px;width:120px">
<input id="promoSpins" placeholder="взрывов" type="number" value="1" style="padding:6px;width:70px">
<button onclick="createPromo()">Создать</button></div><br>
<div id="promos">—</div>
<script>
const KEY = new URLSearchParams(location.search).get('key');
async function load(){
  const r = await fetch('/api/admin/data?key=' + KEY);
  const j = await r.json();
  if(!j.ok){ document.body.innerHTML = 'Ошибка ключа'; return; }
  document.getElementById('stats').textContent = 'Всего задонатили: ' + j.totalDonated + ' ₽ · игроков: ' + j.users.length;
  const ld = j.lastDonation;
  document.getElementById('lastDonation').innerHTML = ld
    ? ld.amount + ' ₽ от ' + (ld.username || '?') + ' → +' + ld.spins_added + ' круток' +
      (ld.recognized ? '' : ' (НЕ РАСПОЗНАН)')
    : 'Пока донатов не было';
  document.getElementById('unrecognized').innerHTML = j.unrecognized.length
    ? '<table><tr><th>Сумма</th><th>Сообщение</th><th>Кому</th></tr>' +
      j.unrecognized.map(d => '<tr><td>' + d.amount + ' ₽</td><td>' + (d.message || '—') + '</td><td>' +
        '<input id="tg' + d.id + '" placeholder="telegram_id" style="width:110px">' +
        ' <button onclick="resolve(' + d.id + ')">Зачислить</button></td></tr>').join('') + '</table>'
    : 'Нет нераспознанных донатов 👌';
  document.getElementById('users').innerHTML =
    '<table><tr><th>Ник TG</th><th>Ник в игре</th><th>Взрывы</th><th>Донат</th><th>Бонус 10к</th><th>+взрывы</th></tr>' +
    j.users.map(u => '<tr><td>' + (u.username || u.telegram_id) + '</td><td>' + (u.game_nick || '—') +
      '</td><td>' + u.spins + '</td><td>' + u.donated + ' ₽</td><td>' + (u.goal_bonus ? '✅' : '—') + '</td><td>' +
      '<input id="sp' + u.telegram_id + '" type="number" value="1" style="width:50px">' +
      ' <button onclick="addSpins(\\'' + u.telegram_id + '\\')">Начислить</button></td></tr>').join('') + '</table>';
  document.getElementById('promos').innerHTML = j.promos.length
    ? '<table><tr><th>Код</th><th>Взрывов</th><th>Использован</th></tr>' +
      j.promos.map(p => '<tr><td>' + p.code + '</td><td>' + p.spins + '</td><td>' +
        (p.used_by ? 'да' : 'нет') + '</td></tr>').join('') + '</table>'
    : 'Нет промокодов';
}
async function addSpins(id){
  const amount = document.getElementById('sp' + id).value;
  await fetch('/api/admin/add-spins', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, telegramId: id, amount: +amount }) });
  load();
}
async function resolve(id){
  const tg = document.getElementById('tg' + id).value;
  await fetch('/api/admin/resolve-donation', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, donationId: id, telegramId: tg }) });
  load();
}
async function createPromo(){
  const code = document.getElementById('promoCode').value.trim().toUpperCase();
  const spins = document.getElementById('promoSpins').value || 1;
  await fetch('/api/admin/create-promo', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, code, spins: +spins }) });
  document.getElementById('promoCode').value = '';
  load();
}
load();
setInterval(load, 15000);
</script></body></html>`;
}

// ====== СТАРТ ======
app.listen(PORT, () => {
  console.log('Золотая Удача запущена на порту ' + PORT);
});
