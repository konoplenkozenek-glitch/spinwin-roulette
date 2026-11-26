// ====== Золотая Удача — сервер (Supabase) ======
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// папка public может лежать рядом с server.js или на уровень выше
const PUB = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, '..', 'public');
app.use(express.static(PUB));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DA_ACCESS_TOKEN = process.env.DA_ACCESS_TOKEN || '';

// Чат АДМИНА (твоя личка с ботом): выигрыши, донаты, алерты
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
// Группа: ТОЛЬКО промокод дня раз в сутки
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== НАСТРОЙКИ ======
const PROGRESS_GOAL = 10000;
const GOAL_BONUS_SPINS = 5;
const DAILY_PROMO_HOUR = 12; // час (по Москве), когда в группу уходит промокод дня

const PACKAGES = [
  { amount: 100,  spins: 1 },
  { amount: 300,  spins: 4 },
  { amount: 1000, spins: 13 }
];

// ====== СПИСОК НАГРАД (выпадает при взрыве) ======
const PRIZES = [
  { name: 'Любая наживка 5 шт',  color: '#ffcf40' },
  { name: 'Приманки на выбор',   color: '#4caf50' },
  { name: '1 бутылка алкоголя',  color: '#ef4444' },
  { name: 'Кофе 500',            color: '#d2a24c' },
  { name: 'Кофе 1000',           color: '#b78cff' },
  { name: 'Золотая монета 1 шт', color: '#ffa726' },
  { name: 'Премиум 3 дня',       color: '#4db8ff' },
  { name: 'Майка 10 шт',         color: '#ff6ec7' },
  { name: 'Нос 10 шт',           color: '#9e9e9e' },
  { name: 'Бокоплав 10 шт',      color: '#7ec84a' },
  { name: 'Медведка 10 шт',      color: '#7ec84a' },
  { name: 'Дрейсена 10 шт',      color: '#4db8ff' },
  { name: 'Перловица 10 шт',     color: '#b78cff' },
  { name: 'Сбитень 10 шт',       color: '#ff7043' },
  { name: 'Золотая монетка 2 шт', color: '#ffd54f' },
  { name: 'Премиум 7 дней',      color: '#4db8ff' },
  { name: 'Премиум 30 дней',     color: '#4caf50' },
  { name: 'Venga II 10k',        color: '#ffd54f' }
];
// ======================================

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
      goal_bonus: 0,
      created_at: Date.now()
    };
    await supabase.from('users').insert(u);
  } else if (chatId && !u.chat_id) {
    u.chat_id = String(chatId);
    await supabase.from('users').update({ chat_id: u.chat_id }).eq('telegram_id', id);
  }
  return u;
}

async function saveUser(u) {
  await supabase.from('users').update({
    spins: u.spins,
    donated: u.donated,
    game_nick: u.game_nick,
    username: u.username,
    goal_bonus: u.goal_bonus || 0
  }).eq('telegram_id', String(u.telegram_id));
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

// строка игрока в формате: @ник (игровой ник: …)
function playerLine(u) {
  return '@' + (u.username || u.telegram_id) +
    (u.game_nick ? ' (игровой ник: ' + u.game_nick + ')' : '');
}

async function grantGoalBonus(u) {
  if (Number(u.donated) >= PROGRESS_GOAL && !u.goal_bonus) {
    u.goal_bonus = 1;
    u.spins = Number(u.spins) + GOAL_BONUS_SPINS;
    await saveUser(u);
    notifyUser(u, `🎉 Цель ${PROGRESS_GOAL.toLocaleString('ru-RU')} ₽ достигнута! Тебе начислено +${GOAL_BONUS_SPINS} взрывов в подарок! 💣`);
    notifyAdmin(`🎉 ${playerLine(u)} закрыл цель ${PROGRESS_GOAL.toLocaleString('ru-RU')} ₽ — бонус +${GOAL_BONUS_SPINS} взрывов!`);
    return true;
  }
  return false;
}

// отправка в любой чат с логированием ошибок
async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN || !chatId) {
    if (!chatId) console.log('TG: не задан chat_id, сообщение не отправлено: ' + text.slice(0, 40));
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
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

// админу (в личку от бота)
async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) {
    console.log('TG: ADMIN_CHAT_ID не задан — уведомление админу не отправлено: ' + text.slice(0, 60));
    return false;
  }
  return sendTelegramMessage(ADMIN_CHAT_ID, text);
}

// игроку в личку (chat_id или фолбэк telegram_id)
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

  const prize = PRIZES[Math.floor(Math.random() * PRIZES.length)];
  console.log('Взрыв: игрок ' + playerLine(u) + ' (' + u.telegram_id + ') -> ' + prize.name);

  // текст в новом формате
  const spinText =
    `🎰 ${playerLine(u)}\n` +
    `Выпало: «${prize.name}»\n` +
    `Круток осталось: ${u.spins}`;

  // игроку в личку
  notifyUser(u, spinText);
  // админу в личку: кто и что выиграл
  notifyAdmin(spinText);

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
    .update({ used_by: String(u.telegram_id), used_at: Date.now() })
    .eq('code', code);
  u.spins = Number(u.spins) + (promo.spins || 1);
  await saveUser(u);

  notifyUser(u, `🎟 Промокод ${code} принят: +${promo.spins || 1} взрыв!`);
  notifyAdmin(`🎟 ${playerLine(u)} активировал промокод ${code} (+${promo.spins || 1} взрыв)`);
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
  let { data: promos } = await supabase
    .from('promos').select('*').order('code', { ascending: true }).limit(50);
  // технические маркеры промокода дня не показываем
  promos = (promos || []).filter(p => !String(p.code).startsWith('DAY-'));

  const totalDonated = (users || []).reduce((s, u) => s + Number(u.donated || 0), 0);

  res.json({
    ok: true,
    users: (users || []).map(u => ({
      telegram_id: u.telegram_id, username: u.username, game_nick: u.game_nick,
      spins: u.spins, donated: u.donated, goal_bonus: u.goal_bonus,
      chat_id: u.chat_id, hasChat: Boolean(u.chat_id)
    })),
    unrecognized: unrecognized || [],
    lastDonation: (lastDonation && lastDonation[0]) || null,
    promos: promos,
    totalDonated
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
  const { error } = await supabase.from('promos').insert({ code, spins });
  res.json({ ok: !error, code: code });
});

app.post('/api/admin/create-promo', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 24);
  if (!code) return res.json({ ok: false });
  const spins = parseInt(req.body.spins, 10) || 1;
  const { error } = await supabase.from('promos').insert({ code, spins });
  res.json({ ok: !error, error: error ? 'exists' : undefined });
});

app.post('/api/admin/delete-promo', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const code = String(req.body.code || '').trim().toUpperCase();
  await supabase.from('promos').delete().eq('code', code);
  res.json({ ok: true });
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
  await grantGoalBonus(u);
  await saveUser(u);

  await supabase.from('donations')
    .update({ recognized: 1, telegram_id: String(u.telegram_id), spins_added: spins })
    .eq('id', d.id);

  notifyUser(u, `💣 Админ зачислил тебе ${spins} взрывов за донат ${d.amount} ₽!`);
  res.json({ ok: true, spins });
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
  res.json({ ok: true, sent });
});

// тест: проверка личных уведомлений админу
// https://твой-адрес.onrender.com/api/test-admin?key=ТВОЙ_ADMIN_KEY
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
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${tgOffset}&timeout=0`);
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
        // подсказка в логах: твой личный chat_id для ADMIN_CHAT_ID
        console.log('TG: личное сообщение от "' + (msg.from.username || msg.from.first_name || '?') +
          '", chat_id = ' + msg.chat.id + ' (если это ты — вставь это число в ADMIN_CHAT_ID)');
        const u = await getUser(msg.from.id);
        if (u && String(u.chat_id || '') !== String(msg.chat.id)) {
          await supabase.from('users')
            .update({ chat_id: String(msg.chat.id) })
            .eq('telegram_id', String(msg.from.id));
        }
      }
    }
  } catch (e) { /* повторим позже */ }
}
setInterval(pollBotUpdates, 15000);
pollBotUpdates();

// ====== ПРОМОКОД ДНЯ (раз в сутки в группу) ======
async function maybePostDailyPromo() {
  if (!GROUP_CHAT_ID) return;
  try {
    const now = new Date(Date.now() + 3 * 3600 * 1000); // московское время (UTC+3)
    const dateStr = now.toISOString().slice(0, 10); // '2026-11-26'
    const hour = now.getUTCHours();
    if (hour < DAILY_PROMO_HOUR) return; // до DAILY_PROMO_HOUR не публикуем

    // маркер на дату — защита от повтора
    const markerCode = 'DAY-' + dateStr;
    const { data: marker } = await supabase
      .from('promos').select('code').eq('code', markerCode).maybeSingle();
    if (marker) return;

    const code = randomPromoCode();
    await supabase.from('promos').insert({ code: markerCode, spins: 0 });
    await supabase.from('promos').insert({ code: code, spins: 1 });

    sendTelegramMessage(GROUP_CHAT_ID,
      `🎟 <b>Промокод дня!</b>\nКод: <code>${code}</code>\n+1 взрыв тому, кто ПЕРВЫЙ введёт его в игре 💣`);
    console.log('Промокод дня опубликован: ' + code);
  } catch (e) {
    console.log('Ошибка промокода дня: ' + e.message);
  }
}
setInterval(maybePostDailyPromo, 10 * 60 * 1000); // проверка каждые 10 минут
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
      await new Promise(res => setTimeout(res, 1100)); // лимит DA: 1 запрос в секунду
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
        await grantGoalBonus(user);

        await supabase.from('donations').insert({
          da_id: String(d.id), amount, message, username,
          telegram_id: String(user.telegram_id),
          spins_added: spins, recognized: 1, ts: Date.now()
        });
        console.log('DA: зачислено ' + spins + ' взрывов игроку ' + (user.username || user.telegram_id));
        notifyUser(user,
          `💥 Спасибо за донат ${amount} ₽! Зачислено ${spins} взрывов.\nОткрой игру и крути! 🎰`);
        notifyAdmin(`💰 Донат ${amount} ₽ от ${playerLine(user)} — зачислено ${spins} взрывов.`);
      } else {
        await supabase.from('donations').insert({
          da_id: String(d.id), amount, message, username,
          telegram_id: null, spins_added: 0, recognized: 0, ts: Date.now()
        });
        console.log('DA: донат НЕ распознан (ник не найден или сумма < 100)');
        notifyAdmin(`⚠️ Донат ${amount} ₽ не распознан. Сообщение: «${message || '—'}», username: ${username || '—'}. Зачисли вручную в админке.`);
      }
    }
  } catch (e) { /* повторим на следующем опросе */ }
}

setInterval(pollDonations, 30000);
pollDonations();

// ====== СТРАНИЦА АДМИНКИ ======
function getAdminHtml() {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Админка — Золотая Удача</title>
<style>
body{font-family:sans-serif;background:#111;color:#eee;padding:16px;max-width:960px;margin:0 auto}
h1{color:#FFD700;font-size:20px}
h2{color:#FFD700;font-size:15px;margin-top:18px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border:1px solid #333;padding:5px 7px;text-align:left}
th{background:#222;color:#FFD700}
button{background:#FFD700;border:none;padding:6px 10px;border-radius:8px;font-weight:bold;cursor:pointer}
button.gray{background:#555;color:#fff}
input,textarea{background:#1a1a1a;color:#eee;border:1px solid #444;border-radius:6px;padding:6px}
.muted{color:#888;font-size:12px}
.progress-wrap{margin:14px 0 4px}
.progress-bar{height:16px;background:rgba(255,255,255,.08);border:1px solid rgba(255,215,0,.4);border-radius:10px;overflow:hidden}
.progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#FF8C00,#FFD700);box-shadow:0 0 10px rgba(255,215,0,.5);transition:width .6s ease}
.progress-fill.done{background:linear-gradient(90deg,#3ddc84,#aef7cf)}
.progress-label{font-size:12px;color:#b8a878;margin-top:5px}
.progress-label.done{color:#3ddc84;font-weight:bold}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#FFD700;color:#000;padding:8px 16px;border-radius:10px;font-weight:bold;display:none;z-index:9}
</style></head><body>
<h1>🛠 Админка — Золотая Удача</h1>
<div class="muted" id="stats"></div>

<div class="progress-wrap">
  <div class="progress-bar"><div class="progress-fill" id="progFill"></div></div>
  <div class="progress-label" id="progLabel"></div>
</div>

<h2>💵 Последний донат</h2><div id="lastDonation">—</div>
<h2>⚠️ Нераспознанные донаты</h2><div id="unrecognized">—</div>
<h2>👥 Игроки</h2>
<div class="row"><input id="searchQ" placeholder="🔍 поиск по нику" style="width:200px"></div><br>
<div id="users">—</div>
<h2>🎟 Промокоды</h2>
<div class="row">
  <input id="promoCode" placeholder="КОД (или сгенерируй)" style="width:180px">
  <input id="promoSpins" placeholder="взрывов" type="number" value="1" style="width:70px">
  <button onclick="createPromo()">Создать</button>
  <button onclick="generatePromo()">🎲 Сгенерировать</button>
</div><br>
<div id="promos">—</div>
<h2>📣 Рассылка</h2>
<div class="row" style="flex-direction:column;align-items:stretch;max-width:600px">
  <textarea id="bcText" rows="3" placeholder="Текст сообщения всем игрокам"></textarea>
  <div><button onclick="broadcast()">Отправить всем</button> <span class="muted" id="bcResult"></span></div>
</div>
<div id="toast"></div>
<script>
const KEY = new URLSearchParams(location.search).get('key');
const GOAL = 10000;
let USERS = [];
function fmt(n){return Number(n).toLocaleString('ru-RU')}
function toast(t){const el=document.getElementById('toast');el.textContent=t;el.style.display='block';setTimeout(function(){el.style.display='none'},2500)}

async function load(){
  const r = await fetch('/api/admin/data?key=' + KEY);
  const j = await r.json();
  if(!j.ok){ document.body.innerHTML = 'Ошибка ключа'; return; }
  USERS = j.users;
  const withChat = j.users.filter(function(u){return u.hasChat}).length;
  document.getElementById('stats').textContent = 'Всего задонатили: ' + fmt(j.totalDonated) + ' ₽ · игроков: ' + j.users.length + ' · уведомления включили: ' + withChat;

  const fill = document.getElementById('progFill');
  const label = document.getElementById('progLabel');
  const pct = Math.min(Math.round(j.totalDonated / GOAL * 100), 100);
  fill.style.width = pct + '%';
  if (j.totalDonated >= GOAL) {
    fill.classList.add('done');
    label.textContent = '🎉 Цель ' + fmt(GOAL) + ' ₽ собрана!';
    label.classList.add('done');
  } else {
    fill.classList.remove('done');
    label.classList.remove('done');
    label.textContent = 'Поступления: ' + fmt(j.totalDonated) + ' из ' + fmt(GOAL) + ' ₽ (' + pct + '%)';
  }

  const ld = j.lastDonation;
  document.getElementById('lastDonation').innerHTML = ld
    ? ld.amount + ' ₽ от ' + (ld.username || '?') + ' → +' + ld.spins_added + ' взрывов' +
      (ld.recognized ? '' : ' (НЕ РАСПОЗНАН)')
    : 'Пока донатов не было';

  document.getElementById('unrecognized').innerHTML = j.unrecognized.length
    ? '<table><tr><th>Сумма</th><th>Сообщение</th><th>Кому</th></tr>' +
      j.unrecognized.map(d => '<tr><td>' + d.amount + ' ₽</td><td>' + (d.message || '—') + '</td><td>' +
        '<input id="tg' + d.id + '" placeholder="telegram_id" style="width:110px">' +
        ' <button onclick="resolve(' + d.id + ')">Зачислить</button></td></tr>').join('') + '</table>'
    : 'Нет нераспознанных донатов 👌';

  renderUsers();
  document.getElementById('promos').innerHTML = j.promos.length
    ? '<table><tr><th>Код</th><th>Взрывов</th><th>Использован</th><th></th></tr>' +
      j.promos.map(p => '<tr><td style="font-family:monospace">' + p.code + '</td><td>' + p.spins + '</td><td>' +
        (p.used_by ? 'да (' + p.used_by + ')' : 'нет') + '</td><td>' +
        '<button class="gray" onclick="delPromo(\\'' + p.code + '\\')">✕</button></td></tr>').join('') + '</table>'
    : 'Нет промокодов';
}

function renderUsers(){
  const q = (document.getElementById('searchQ').value || '').toLowerCase();
  const list = USERS.filter(u =>
    !q || (u.username || '').toLowerCase().indexOf(q) >= 0 ||
    (u.game_nick || '').toLowerCase().indexOf(q) >= 0 ||
    String(u.telegram_id).indexOf(q) >= 0);
  document.getElementById('users').innerHTML = list.length
    ? '<table><tr><th>Ник TG</th><th>Ник в игре</th><th>🔔</th><th>Взрывы</th><th>Донат</th><th>Бонус 10к</th><th>Корректировка</th></tr>' +
      list.map(u => '<tr><td>' + (u.username || u.telegram_id) + '</td><td>' + (u.game_nick || '—') +
      '</td><td>' + (u.hasChat ? '🔔' : '🔕') + '</td>' +
      '<td><input id="sp' + u.telegram_id + '" type="number" value="' + u.spins + '" style="width:60px"></td>' +
      '<td><input id="dn' + u.telegram_id + '" type="number" value="' + u.donated + '" style="width:70px"></td>' +
      '<td>' + (u.goal_bonus ? '✅' : '—') + '</td><td>' +
      '<button onclick="saveUser(\\'' + u.telegram_id + '\\')">Сохранить</button> ' +
      '<button onclick="addSpins(\\'' + u.telegram_id + '\\')">+1</button></td></tr>').join('') + '</table>'
    : 'Никого не найдено';
}

async function saveUser(id){
  const spins = document.getElementById('sp' + id).value;
  const donated = document.getElementById('dn' + id).value;
  await fetch('/api/admin/update-user', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, telegramId: id, spins: spins, donated: donated }) });
  toast('Сохранено ✅');
  load();
}
async function addSpins(id){
  await fetch('/api/admin/add-spins', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, telegramId: id, amount: 1 }) });
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
  const r = await fetch('/api/admin/create-promo', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, code, spins: +spins }) });
  const j = await r.json();
  if (j.ok) { toast('Промокод создан ✅'); document.getElementById('promoCode').value=''; }
  else toast('Такой код уже есть');
  load();
}
async function generatePromo(){
  const spins = document.getElementById('promoSpins').value || 1;
  const r = await fetch('/api/admin/generate-promo', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, spins: +spins }) });
  const j = await r.json();
  if (j.ok) {
    toast('Код: ' + j.code);
    navigator.clipboard && navigator.clipboard.writeText(j.code);
  }
  load();
}
async function delPromo(code){
  await fetch('/api/admin/delete-promo', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, code: code }) });
  load();
}
async function broadcast(){
  const text = document.getElementById('bcText').value.trim();
  if (!text) return;
  const r = await fetch('/api/admin/broadcast', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: KEY, text: text }) });
  const j = await r.json();
  document.getElementById('bcResult').textContent = 'Доставлено: ' + j.sent;
}
document.getElementById('searchQ').addEventListener('input', renderUsers);
load();
setInterval(load, 15000);
</script></body></html>`;
}

// ====== СТАРТ ======
app.listen(PORT, () => {
  console.log('Золотая Удача запущена на порту ' + PORT);
});
