// ====== Золотая Удача — сервер (Supabase) ======
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DA_ACCESS_TOKEN = process.env.DA_ACCESS_TOKEN || '';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== НАСТРОЙКИ ПАКЕТОВ И ЦЕЛИ ======
const PROGRESS_GOAL = 10000;   // цель прогресс-бара, ₽
const GOAL_BONUS_SPINS = 5;    // сколько взрывов за достижение цели

const PACKAGES = [
  { amount: 100,  spins: 1 },
  { amount: 300,  spins: 4 },
  { amount: 1000, spins: 13 }
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
async function grantGoalBonus(u) {
  if (Number(u.donated) >= PROGRESS_GOAL && !u.goal_bonus) {
    u.goal_bonus = 1;
    u.spins = Number(u.spins) + GOAL_BONUS_SPINS;
    await saveUser(u);
    sendTelegramMessage(u.chat_id,
      `🎉 Цель ${PROGRESS_GOAL.toLocaleString('ru-RU')} ₽ достигнута! Тебе начислено +${GOAL_BONUS_SPINS} взрывов в подарок! 💣`);
    return true;
  }
  return false;
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
    totalPlayers: total || 0
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

  res.json({ ok: true, spinsLeft: u.spins });
});

app.post('/api/redeem-promo', async (req, res) => {
  const tgUser = verifyInitData(req.body.initData);
  if (!tgUser) return res.json({ ok: false, error: 'auth' });
  const u = await ensureUser(tgUser, null);

  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.json({ ok: false, error: 'not_found' });

  const { data: promo } = await supabase.from('promos').select('*').eq('code', code).maybeSingle();
  if (!promo) return res.json({ ok: false, error: 'not_found' });
  if (promo.used_by) return res.json({ ok: false, error: 'used' });

  await supabase.from('promos')
    .update({ used_by: String(u.telegram_id), used_at: Date.now() })
    .eq('code', code);
  u.spins = Number(u.spins) + (promo.spins || 1);
  await saveUser(u);

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
  const { data: promos } = await supabase
    .from('promos').select('*').order('code', { ascending: true }).limit(50);

  const totalDonated = (users || []).reduce((s, u) => s + Number(u.donated || 0), 0);

  res.json({
    ok: true,
    users: (users || []).map(u => ({
      telegram_id: u.telegram_id, username: u.username, game_nick: u.game_nick,
      spins: u.spins, donated: u.donated, goal_bonus: u.goal_bonus
    })),
    unrecognized: unrecognized || [],
    lastDonation: (lastDonation && lastDonation[0]) || null,
    promos: promos || [],
    totalDonated
  });
});

app.post('/api/admin/add-spins', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const u = await getUser(req.body.telegramId);
  if (!u) return res.json({ ok: false, error: 'no_user' });
  u.spins = Number(u.spins) + (parseInt(req.body.amount, 10) || 0);
  await saveUser(u);
  res.json({ ok: true, spins: u.spins });
});

app.post('/api/admin/create-promo', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 12);
  if (!code) return res.json({ ok: false });
  const spins = parseInt(req.body.spins, 10) || 1;
  const { error } = await supabase.from('promos').insert({ code, spins });
  res.json({ ok: !error, error: error ? 'exists' : undefined });
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

  sendTelegramMessage(u.chat_id, `💣 Админ зачислил тебе ${spins} взрывов за донат ${d.amount} ₽!`);
  res.json({ ok: true, spins });
});

app.get('/api/admin/test-spins', (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ ok: false });
  const samples = [100, 300, 500, 1000, 1300, 2000, 10000];
  res.json({ ok: true, packages: PACKAGES, samples: samples.map(a => ({ amount: a, spins: spinsForAmount(a) })) });
});

// ====== ПОЛУЧЕНИЕ ДОНАТОВ С DONATIONALERTS ======
async function pollDonations() {
  if (!DA_ACCESS_TOKEN) return;
  try {
    const r = await fetch('https://www.donationalerts.com/api/v1/donations?sort=id_desc&limit=10', {
      headers: { Authorization: 'Bearer ' + DA_ACCESS_TOKEN }
    });
    const j = await r.json();
    const list = (j.data || []).slice().reverse(); // от старых к новым

    for (const d of list) {
      // дедупликация через базу: если донат уже записан — пропускаем
      const { data: existing } = await supabase
        .from('donations').select('id').eq('da_id', String(d.id)).maybeSingle();
      if (existing) continue;

      const amount = parseFloat(d.amount) || 0;
      const message = d.message || '';
      const username = d.username || '';

      // ищем игрока по @нику в сообщении или по username
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
        sendTelegramMessage(user.chat_id,
          `💥 Спасибо за донат ${amount} ₽! Зачислено ${spins} взрывов.\nОткрой игру и крути! 🎰`);
      } else {
        await supabase.from('donations').insert({
          da_id: String(d.id), amount, message, username,
          telegram_id: null, spins_added: 0, recognized: 0, ts: Date.now()
        });
      }
    }
  } catch (e) { /* повторим на следующем опросе */ }
}

setInterval(pollDonations, 30000); // каждые 30 секунд
pollDonations();

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
