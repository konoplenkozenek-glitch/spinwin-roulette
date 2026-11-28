// ====== Золотая Удача — сервер (Supabase) ======
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const PUB = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, '..', 'public');
app.use(express.static(PUB));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DA_ACCESS_TOKEN = process.env.DA_ACCESS_TOKEN || '';

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== НАСТРОЙКИ ======
const DA_CUTOFF_HOURS = 24;
const DAILY_PROMO_HOUR = 12;

const PACKAGES = [
  { amount: 100,  spins: 1 },
  { amount: 300,  spins: 4 },
  { amount: 1000, spins: 13 }
];

// ====== СИСТЕМА ТИТУЛОВ ======
const TIERS = [
  { name: 'Новичок',  from: 0,      bonus: 0  },
  { name: 'Бронза',   from: 10000,  bonus: 5  },
  { name: 'Серебро',  from: 25000,  bonus: 10 },
  { name: 'Золото',   from: 50000,  bonus: 20 },
  { name: 'Легенда',  from: 100000, bonus: 50 }
];

function tierIndexFor(donated) {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) {
    if (donated >= TIERS[i].from) idx = i;
  }
  return idx;
}

async function grantTier(u) {
  const d = Number(u.donated) || 0;
  const newTier = tierIndexFor(d);
  const oldTier = Number(u.tier) || 0;
  if (newTier <= oldTier) return false;

  const t = TIERS[newTier];
  u.tier = newTier;
  u.spins = Number(u.spins) + t.bonus;
  await saveUser(u);

  const text = '🏅 Новый титул: ' + t.name + '! Тебе начислено +' + t.bonus + ' взрывов в подарок! 💣';
  const sentToPlayer = await notifyUser(u, text);
  if (!sentToPlayer || !isAdminUser(u)) {
    notifyAdmin('🏅 ' + playerLine(u) + ' получил титул ' + t.name + ' (' + d.toLocaleString('ru-RU') + ' ₽) — бонус +' + t.bonus + ' взрывов!');
  }
  return true;
}

// ====== СПИСОК НАГРАД (ИЗМЕНЕНЫ ТОЛЬКО 3 СТРОКИ) ======
const PRIZES = [
  { name: 'Любая наживка 5 шт',   color: '#ffcf40', chance: 6.65 },
  { name: 'Приманки на выбор',    color: '#4caf50', chance: 6.65 },
  { name: '1 бутылка алкоголя',   color: '#ef4444', chance: 6.65 },
  { name: 'Кофе 500',             color: '#d2a24c', chance: 6.65 },
  { name: 'Кофе 1000',            color: '#b78cff', chance: 4.5 }, // ВАШ ЗАПРОС (было 6.65)
  { name: 'Золотая монета 1 шт',  color: '#ffa726', chance: 5.0 }, // ВАШ ЗАПРОС (было 6.65)
  { name: 'Премиум 3 дня',        color: '#4db8ff', chance: 5 },
  { name: 'Майка 10 шт',          color: '#ff6ec7', chance: 6.65 },
  { name: 'Нос 10 шт',            color: '#9e9e9e', chance: 6.65 },
  { name: 'Бокоплав 10 шт',       color: '#7ec84a', chance: 6.65 },
  { name: 'Медведка 10 шт',       color: '#7ec84a', chance: 6.65 },
  { name: 'Дрейсена 10 шт',       color: '#4db8ff', chance: 6.65 },
  { name: 'Перловица 10 шт',      color: '#b78cff', chance: 6.65 },
  { name: 'Сбитень 10 шт',        color: '#ff7043', chance: 6.65 },
  { name: 'Золотая монетка 2 шт', color: '#ffd54f', chance: 3.0 }, // ВАШ ЗАПРОС (было 5)
  { name: 'Премиум 7 дней',       color: '#4db8ff', chance: 3 },
  { name: 'Премиум 30 дней',      color: '#4caf50', chance: 0.5 },
  { name: 'Venga II 10k',         color: '#ffd54f', chance: 0.001 }
];

function prizeColor(name) {
  const p = PRIZES.find(x => x.name === name);
  return p ? p.color : '#FFD700';
}

function pickPrize() {
  const total = PRIZES.reduce((s, p) => s + p.chance, 0);
  let r = Math.random() * total;
  for (const p of PRIZES) {
    r -= p.chance;
    if (r <= 0) return p;
  }
  return PRIZES[PRIZES.length - 1];
}

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

async function getUser(telegramId) {
  const { data } = await supabase
    .from('users').select('*').eq('telegram_id', String(telegramId)).maybeSingle();
  return data || null;
}

async function ensureUser(tgUser, chatId) {
  const id = String(tgUser.id);
  let u = await getUser(id);
  if (!u) {
    u = {
      telegram_id: id,
      username: tgUser.username || tgUser.first_name || '',
      chat_id: chatId || null,
      game_nick: null,
      spins: 0,
      donated: 0,
      tier: 0,
      goal_bonus: 0,
      created_at: Date.now()
    };
    const { error } = await supabase.from('users').insert(u);
    if (error) console.log('SUPABASE: не создал игрока ' + id + ' -> ' + error.message);
  } else if (chatId && String(u.chat_id || '') !== String(chatId)) {
    u.chat_id = String(chatId);
    await supabase.from('users').update({ chat_id: u.chat_id }).eq('telegram_id', id);
  }
  return u;
}

async function saveUser(u) {
  const { error } = await supabase.from('users').update({
    spins: u.spins,
    donated: u.donated,
    game_nick: u.game_nick,
    username: u.username,
    tier: u.tier || 0,
    goal_bonus: u.goal_bonus || 0
  }).eq('telegram_id', String(u.telegram_id));
  if (error) console.log('SUPABASE: ошибка сохранения игрока ' + u.telegram_id + ' -> ' + error.message);
  return !error;
}

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

function playerLine(u) {
  return '@' + (u.username || u.telegram_id) +
    (u.game_nick ? ' (игровой ник: ' + u.game_nick + ')' : '');
}

function isAdminUser(u) {
  if (!ADMIN_CHAT_ID) return false;
  return String(u.chat_id || '') === String(ADMIN_CHAT_ID) ||
         String(u.telegram_id || '') === String(ADMIN_CHAT_ID);
}

async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN || !chatId) {
    if (!chatId) console.log('TG: не задан chat_id, сообщение не отправлено: ' + text.slice(0, 40));
    return false;
  }
  try {
    const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
    if (!r.ok) {
      const body = await r.text();
      console.log('TG: ошибка отправки в ' + chatId + ' -> ' + r.status + ' ' + body.slice(0, 200));
    }
    return r.ok;
  } catch (e) {
    console.log('TG: сбой отправки в ' + chatId + ': ' + e.message);
    return false;
  }
}

async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) {
    console.log('TG: ADMIN_CHAT_ID не задан — уведомление админу не отправлено: ' + text.slice(0, 60));
    return false;
  }
  return sendTelegramMessage(ADMIN_CHAT_ID, text);
}

async function notifyUser(u, text) {
  const target = u.chat_id || u.telegram_id;
  const ok = await sendTelegramMessage(target, text);
  if (!ok) {
    console.log('TG: не смог отправить личное сообщение игроку ' +
      (u.username || u.telegram_id) + ' — пусть нажмёт Start у бота');
  }
  return ok;
}

function randomPromoCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'LUCK-' + s;
}

// ====== API МИНИ-АППА ======
app.post('/api/me', async (req, res) => {
  const tgUser = verifyInitData(req.body.initData);
  if (!tgUser) return res.json({ ok: false, error: 'auth' });
  const u = await ensureUser(tgUser, null);

  if (req.body.gameNick) {
    u.game_nick = String(req.body.gameNick).slice(0, 40);
    await saveUser(u);
  }

  const { count: above } = await supabase
    .from('users').select('telegram_id', { count: 'exact', head: true })
    .gt('donated', Number(u.donated));
  const { count: total } = await supabase
    .from('users').select('telegram_id', { count: 'exact', head: true })
    .gt('donated', 0);

  res.json({
    ok: true,
    spins: Number(u.spins),
    donated: Number(u.donated),
    gameNick: u.game_nick,
    tier: TIERS[Number(u.tier) || 0] ? TIERS[Number(u.tier) || 0].name : 'Новичок',
    rank: (above || 0) + 1,
    totalPlayers: total || 0,
    hasChat: Boolean(u.chat_id)
  });
});

app.post('/api/spin', async (req, res) => {
  const tgUser = verifyInitData(req.body.initData);
  if (!tgUser) return res.json({ ok: false, error: 'auth', message: 'Ошибка авторизации' });
  const u = await ensureUser(tgUser, null);

  if (Number(u.spins) <= 0) {
    return res.json({ ok: false, error: 'no_spins', message: 'Нет взрывов! Задонать и крути 💣' });
  }

  u.spins = Number(u.spins) - 1;
  await saveUser(u);

  const prize = pickPrize();
  console.log('Взрыв: игрок ' + playerLine(u) + ' (' + u.telegram_id + ') -> ' + prize.name);

  const { error: winErr } = await supabase.from('wins').insert({
    telegram_id: String(u.telegram_id),
    username: u.username || '',
    game_nick: u.game_nick || null,
    prize: prize.name,
    ts: Date.now()
  });
  if (winErr) console.log('SUPABASE: не записал выигрыш -> ' + winErr.message);

  const spinText =
    '🎰 ' + playerLine(u) + '\n' +
    'Выпало: «' + prize.name + '»\n' +
    'Круток осталось: ' + u.spins;

  const sentToPlayer = await notifyUser(u, spinText);
  if (!sentToPlayer || !isAdminUser(u)) {
    notifyAdmin(spinText);
  }

  res.json({ ok: true, spinsLeft: u.spins, prize: prize });
});

app.post('/api/redeem-promo', async (req, res) => {
  const tgUser = verifyInitData(req.body.initData);
  if (!tgUser) return res.json({ ok: false, error: 'auth' });
  const u = await ensureUser(tgUser, null);

  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code || code.startsWith('DAY-')) return res.json({ ok: false, error: 'not_found' });

  const { data: promo } = await supabase.from('promos').select('*').eq('code', code).maybeSingle();
  if (!promo) return res.json({ ok: false, error: 'not_found' });
  if (promo.used_by) return res.json({ ok: false, error: 'used' });

  await supabase.from('promos')
    .update({ 
      used_by: String(u.telegram_id), 
      used_username: u.username || u.telegram_id,
      used_game_nick: u.game_nick || null,
      used_at: Date.now() 
    })
    .eq('code', code);

  u.spins = Number(u.spins) + (promo.spins || 1);
  await saveUser(u);

  const promoText = '🎟 Промокод ' + code + ' принят: +' + (promo.spins || 1) + ' взрыв!';
  const sentToPlayer = await notifyUser(u, promoText);
  if (!sentToPlayer || !isAdminUser(u)) {
    notifyAdmin('🎟 ' + playerLine(u) + ' активировал промокод ' + code + ' (+' + (promo.spins || 1) + ' взрыв)');
  }
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

app.get('/api/admin/data', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });

  const { data: users } = await supabase
    .from('users').select('*').order('donated', { ascending: false });
  const { data: unrecognized } = await supabase
    .from('donations').select('*').eq('recognized', 0)
    .order('ts', { ascending: false }).limit(20);
  const { data: lastDonation } = await supabase
    .from('donations').select('*').order('ts', { ascending: false }).limit(1);
  const { data: wins } = await supabase
    .from('wins').select('*').order('ts', { ascending: false }).limit(50);
  let { data: promos } = await supabase
    .from('promos').select('*').order('code', { ascending: true }).limit(50);
  promos = (promos || []).filter(p => !String(p.code).startsWith('DAY-'));

  const totalDonated = (users || []).reduce((s, u) => s + Number(u.donated || 0), 0);
  const totalSpins = (users || []).reduce((s, u) => s + Number(u.spins || 0), 0);

  res.json({
    ok: true,
    users: (users || []).map(u => ({
      telegram_id: u.telegram_id, username: u.username, game_nick: u.game_nick,
      spins: u.spins, donated: u.donated,
      tier: Number(u.tier) || 0, tierName: TIERS[Number(u.tier) || 0] ? TIERS[Number(u.tier) || 0].name : 'Новичок',
      goal_bonus: u.goal_bonus,
      chat_id: u.chat_id, hasChat: Boolean(u.chat_id)
    })),
    unrecognized: unrecognized || [],
    lastDonation: (lastDonation && lastDonation[0]) || null,
    wins: wins || [],
    promos: promos,
    totalDonated: totalDonated,
    totalSpins: totalSpins,
    totalWins: (wins || []).length
  });
});

app.post('/api/admin/update-user', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const u = await getUser(req.body.telegramId);
  if (!u) return res.json({ ok: false, error: 'no_user' });

  if (req.body.spins !== undefined && req.body.spins !== '') u.spins = parseInt(req.body.spins, 10) || 0;
  if (req.body.donated !== undefined && req.body.donated !== '') u.donated = parseInt(req.body.donated, 10) || 0;
  if (req.body.gameNick) u.game_nick = String(req.body.gameNick).slice(0, 40);
  await saveUser(u);
  await grantTier(u);
  res.json({ ok: true });
});

app.post('/api/admin/add-spins', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const u = await getUser(req.body.telegramId);
  if (!u) return res.json({ ok: false, error: 'no_user' });
  u.spins = Number(u.spins) + (parseInt(req.body.amount, 10) || 0);
  await saveUser(u);
  res.json({ ok: true, spins: u.spins });
});

app.post('/api/admin/generate-promo', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const spins = parseInt(req.body.spins, 10) || 1;
  const code = randomPromoCode();
  const { error } = await supabase.from('promos').insert({ code: code, spins: spins });
  res.json({ ok: !error, code: code });
});

app.post('/api/admin/create-promo', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 24);
  if (!code) return res.json({ ok: false });
  const spins = parseInt(req.body.spins, 10) || 1;
  const { error } = await supabase.from('promos').insert({ code: code, spins: spins });
  res.json({ ok: !error, error: error ? 'exists' : undefined, code: code });
});

app.post('/api/admin/delete-promo', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const code = String(req.body.code || '').trim().toUpperCase();
  await supabase.from('promos').delete().eq('code', code);
  res.json({ ok: true });
});

app.post('/api/admin/clear-wins', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const { error } = await supabase.from('wins').delete().neq('id', 0);
  if (error) console.log('SUPABASE: не очистил выигрыши -> ' + error.message);
  res.json({ ok: !error });
});

app.post('/api/admin/resolve-donation', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });

  const { data: d } = await supabase.from('donations')
    .select('*').eq('id', req.body.donationId).maybeSingle();
  if (!d) return res.json({ ok: false, error: 'no_donation' });

  const u = await getUser(req.body.telegramId);
  if (!u) return res.json({ ok: false, error: 'no_user' });

  const spins = spinsForAmount(Number(d.amount));
  u.spins = Number(u.spins) + spins;
  u.donated = Number(u.donated) + Number(d.amount);
  await saveUser(u);
  await grantTier(u);

  await supabase.from('donations')
    .update({ recognized: 1, telegram_id: String(u.telegram_id), spins_added: spins })
    .eq('id', d.id);

  notifyUser(u, '💣 Админ зачислил тебе ' + spins + ' взрывов за донат ' + d.amount + ' ₽!');
  res.json({ ok: true, spins: spins });
});

app.post('/api/admin/delete-donation', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  await supabase.from('donations').update({ recognized: 2 }).eq('id', req.body.donationId);
  res.json({ ok: true });
});

app.post('/api/admin/clear-donations', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  await supabase.from('donations').update({ recognized: 2 }).eq('recognized', 0);
  res.json({ ok: true });
});

app.post('/api/admin/broadcast', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const text = String(req.body.text || '').trim();
  if (!text) return res.json({ ok: false });

  const { data: users } = await supabase
    .from('users').select('chat_id, telegram_id');
  let sent = 0;
  for (const u of (users || [])) {
    const ok = await sendTelegramMessage(u.chat_id || u.telegram_id, text);
    if (ok) sent++;
    await new Promise(r => setTimeout(r, 100));
  }
  res.json({ ok: true, sent: sent });
});

app.get('/api/test-admin', (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  notifyAdmin('🧪 Тест личных уведомлений — если видишь это, всё настроено!');
  res.json({ ok: true, admin: ADMIN_CHAT_ID || '(ADMIN_CHAT_ID не задан)' });
});

// ====== СБОР CHAT_ID ЧЕРЕЗ БОТА ======
let tgOffset = 0;
let getUpdatesBroken = false;
async function pollBotUpdates() {
  if (!BOT_TOKEN || getUpdatesBroken) return;
  try {
    const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates?offset=' + tgOffset + '&timeout=0');
    const j = await r.json();
    if (!j.ok) {
      if (j.error_code === 409 && !getUpdatesBroken) {
        getUpdatesBroken = true;
        console.log('TG: у бота активен webhook — chat_id собираются только через Start игроков');
      }
      return;
    }
    for (const upd of (j.result || [])) {
      if (upd.update_id >= tgOffset) tgOffset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg || !msg.chat) continue;

      if (msg.chat.type === 'private' && msg.from) {
        console.log('TG: личное сообщение от "' + (msg.from.username || msg.from.first_name || '?') +
          '", chat_id = ' + msg.chat.id + ' (если это ты — вставь это число в ADMIN_CHAT_ID)');
        await ensureUser(msg.from, String(msg.chat.id));
      }
    }
  } catch (e) { /* повторим позже */ }
}
setInterval(pollBotUpdates, 15000);
pollBotUpdates();

// ====== ПРОМОКОД ДНЯ ======
async function maybePostDailyPromo() {
  if (!GROUP_CHAT_ID) return;
  try {
    const now = new Date(Date.now() + 3 * 3600 * 1000);
    const dateStr = now.toISOString().slice(0, 10);
    const hour = now.getUTCHours();
    if (hour < DAILY_PROMO_HOUR) return;

    const markerCode = 'DAY-' + dateStr;
    const { data: marker } = await supabase
      .from('promos').select('code').eq('code', markerCode).maybeSingle();
    if (marker) return;

    const code = randomPromoCode();
    await supabase.from('promos').insert({ code: markerCode, spins: 0 });
    await supabase.from('promos').insert({ code: code, spins: 1 });

    sendTelegramMessage(GROUP_CHAT_ID,
      '🎟 <b>Промокод дня!</b>\nКод: <code>' + code + '</code>\n+1 взрыв тому, кто ПЕРВЫЙ введёт его в игре 💣');
    console.log('Промокод дня опубликован: ' + code);
  } catch (e) {
    console.log('Ошибка промокода дня: ' + e.message);
  }
}
setInterval(maybePostDailyPromo, 10 * 60 * 1000);
maybePostDailyPromo();

// ====== ПОЛУЧЕНИЕ ДОНАТОВ С DONATIONALERTS ======
async function pollDonations() {
  if (!DA_ACCESS_TOKEN) return;
  try {
    const r1 = await fetch('https://www.donationalerts.com/api/v1/alerts/donations?page=1', {
      headers: { Authorization: 'Bearer ' + DA_ACCESS_TOKEN }
    });
    if (!r1.ok) {
      console.log('DA API ответил ' + r1.status + ' — проверь токен DA_ACCESS_TOKEN и скоуп oauth-donation-index');
      return;
    }
    const j1 = await r1.json();
    const batches = [j1.data || []];
    if (j1.meta && j1.meta.last_page > 1) {
      await new Promise(res => setTimeout(res, 1100));
      const r2 = await fetch('https://www.donationalerts.com/api/v1/alerts/donations?page=' + j1.meta.last_page, {
        headers: { Authorization: 'Bearer ' + DA_ACCESS_TOKEN }
      });
      if (r2.ok) {
        const j2 = await r2.json();
        batches.push(j2.data || []);
      }
    }
    const list = batches.flat();

    for (const d of list) {
      if (d.created_at) {
        const created = new Date(d.created_at).getTime();
        if (created && created < Date.now() - DA_CUTOFF_HOURS * 3600 * 1000) continue;
      }

      const { data: existing } = await supabase
        .from('donations').select('id').eq('da_id', String(d.id)).maybeSingle();
      if (existing) continue;

      const amount = parseFloat(d.amount) || 0;
      const message = d.message || '';
      const username = d.username || '';
      console.log('DA: новый донат ' + amount + ' ₽ от ' + (username || '?') + ' — сообщение: "' + message + '"');

      let user = null;
      const nickMatch = message.match(/@([A-Za-z0-9_]{3,32})/);
      if (nickMatch) {
        const found = await supabase.from('users')
          .select('*').ilike('username', nickMatch[1]).maybeSingle();
        user = found.data;
      }
      if (!user && username) {
        const found = await supabase.from('users')
          .select('*').ilike('username', username).maybeSingle();
        user = found.data;
      }

      if (user && amount >= 100) {
        const spins = spinsForAmount(amount);
        user.spins = Number(user.spins) + spins;
        user.donated = Number(user.donated) + amount;
        const saved = await saveUser(user);
        if (!saved) {
          console.log('DA: НЕ удалось сохранить взрывы игроку ' + (user.username || user.telegram_id));
        }
        await grantTier(user);

        const { error: insErr } = await supabase.from('donations').insert({
          da_id: String(d.id), amount: amount, message: message, username: username,
          telegram_id: String(user.telegram_id),
          spins_added: spins, recognized: 1, ts: Date.now()
        });
        if (insErr) console.log('SUPABASE: не записал донат -> ' + insErr.message);
        console.log('DA: зачислено ' + spins + ' взрывов игроку ' + (user.username || user.telegram_id));

        const donText =
          '💰 ' + playerLine(user) + '\n' +
          'Донат: ' + amount + ' ₽\n' +
          'Зачислено круток: ' + spins;

        const sentToPlayer = await notifyUser(user,
          '💥 Спасибо за донат ' + amount + ' ₽! Зачислено ' + spins + ' взрывов.\nОткрой игру и крути! 🎰');
        if
