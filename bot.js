// ====== БОТ «ПОСТЫ РР4» v4 — теги, просмотры, только опубликованные ======
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.POSTS_BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== СПИСОК ВОДОЁМОВ ======
const WATERS = [
  'оз. Комариное',
  'оз. Лосиное',
  'р. Вьюнок',
  'оз. Старый Острог',
  'р. Белая',
  'оз. Кугор',
  'оз. Медвежье',
  'р. Волхов',
  'р. Северский Донец',
  'р. Сура',
  'Ладожское оз.',
  'оз. Янтарное',
  'р. Ахтуба',
  'оз. Медное',
  'р. Нижняя Тунгуска',
  'р. Яма',
  'Норвежское море'
];

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Нет POSTS_BOT_TOKEN / SUPABASE_URL / SUPABASE_KEY — бот постов не запущен');
} else {
  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log('Бот постов запущен');

  const isAdmin = (chatId) => ADMIN_CHAT_ID && String(chatId) === ADMIN_CHAT_ID;
  const LINE = '━━━━━━━━━━━━━━━';
  const drafts = {};
  const POSTS_URL = 'https://spinwin-roulette.onrender.com/posts';

  // ---------- Оформление ----------
  function postText(water, body, link) {
    let t =
      '🎣 ' + LINE + ' 🎣\n\n' +
      '🌊  <b>' + water.toUpperCase() + '</b>\n\n' +
      LINE + '\n\n';
    if (body) t += body + '\n\n' + LINE + '\n\n';
    if (link) t += '📖 <a href="' + link + '">Полный пост — читать в канале</a>\n';
    t += '🐟 Удачной рыбалки!\n👀 Все посты: ' + POSTS_URL;
    return t;
  }

  function soonText(water) {
    return '🎣 ' + LINE + ' 🎣\n\n' +
      '🌊  <b>' + water.toUpperCase() + '</b>\n\n' + LINE + '\n\n' +
      '⏳ Пост об этом водоёме скоро появится!\n' +
      'Следи за обновлениями — будет интересно 🐟\n\n' +
      '📝 Свой пост можно добавить на сайте: ' + POSTS_URL;
  }

  // ---------- Меню ----------
  async function postsMap() {
    const { data } = await supabase.from('posts').select('water').or('status.is.null,status.eq.1');
    const map = {};
    (data || []).forEach(p => { map[p.water] = true; });
    return map;
  }

  async function sendMenu(chatId) {
    const has = await postsMap();
    const rows = [];
    for (let i = 0; i < WATERS.length; i += 2) {
      const row = [];
      WATERS.slice(i, i + 2).forEach((w, idx) => {
        row.push({ text: (has[w] ? '✅ ' : '⏳ ') + w, callback_data: 'water:' + (i + idx) });
      });
      rows.push(row);
    }
    const text =
      '🎣 <b>ПОСТЫ РР4</b>\n\n' +
      'Выбери водоём — откроется пост про него.\n' +
      '✅ — пост готов, ⏳ — скоро появится.\n\n' +
      '💌 Все посты также живут на сайте: ' + POSTS_URL;
    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows }
    });
  }

  // ---------- Показ поста ----------
  async function showPost(chatId, idx) {
    const water = WATERS[idx];
    const next = (idx + 1) % WATERS.length;
    const keyboard = {
      inline_keyboard: [[
        { text: '⬅️ Меню', callback_data: 'menu' },
        { text: '🎣 Следующий ▶️', callback_data: 'water:' + next }
      ]]
    };
    const { data: post } = await supabase.from('posts')
      .select('*').eq('water', water).or('status.is.null,status.eq.1').maybeSingle();

    if (!post) {
      await bot.sendMessage(chatId, soonText(water), {
        parse_mode: 'HTML', reply_markup: keyboard
      });
      return;
    }

    // Характеристики ловли
    let specs = '';
    if (post.tags)   specs += '🏷 Снасти: <b>' + post.tags + '</b>\n';
    if (post.fish)   specs += '🎯 Рыба: <b>' + post.fish + '</b>\n';
    if (post.coords) specs += '📍 Точка: <b>' + post.coords + '</b>\n';
    if (post.depth)  specs += '🌊 Глубина: <b>' + post.depth + '</b>\n';
    if (post.clip)   specs += '🎚 Клипса: <b>' + post.clip + '</b>\n';
    if (post.bait)   specs += '🪱 Наживка: <b>' + post.bait + '</b>\n';
    if (post.feed)   specs += '🥣 Прикормка: <b>' + post.feed + '</b>\n';

    const body = ((specs ? specs + '\n' + LINE + '\n\n' : '') + (post.text || post.caption || '')).trim();
    const text = postText(water, body, post.link);

    // Фото: сначала base64 с сайта, потом file_id бота, потом URL
    let photos = [];
    try { photos = post.photos ? JSON.parse(post.photos) : []; } catch (e) { photos = []; }

    if (photos.length) {
      const m = String(photos[0]).match(/^data:image\/\w+;base64,(.+)$/);
      if (m) {
        const buf = Buffer.from(m[1], 'base64');
        await bot.sendPhoto(chatId, buf, {
          caption: text.slice(0, 1024), parse_mode: 'HTML', reply_markup: keyboard
        }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard }));
        return;
      }
    }
    const photo = post.photo_id || post.photo_url || null;
    if (photo) {
      await bot.sendPhoto(chatId, photo, {
        caption: text.slice(0, 1024), parse_mode: 'HTML', reply_markup: keyboard
      }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard }));
    } else {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML', reply_markup: keyboard
      });
    }
  }

  // ---------- Сохранение поста (созданного через бота) ----------
  async function savePost(chatId, d) {
    await supabase.from('posts').delete().eq('water', d.water);
    const { error } = await supabase.from('posts').insert({
      water: d.water,
      photo_id: d.photoId,
      caption: d.caption,
      link: d.link,
      status: 1,
      created_at: Date.now()
    });
    if (error) {
      console.log('SUPABASE: не сохранил пост -> ' + error.message);
      await bot.sendMessage(chatId, '⚠️ Ошибка сохранения в базу. Проверь таблицу posts.');
      return;
    }
    await bot.sendMessage(chatId, '✅ Пост опубликован! Смотри, как он выглядит:');
    const idx = WATERS.indexOf(d.water);
    if (idx >= 0) await showPost(chatId, idx);
  }

  // ---------- Команды ----------
  bot.onText(/\/start/, async (msg) => {
    await sendMenu(msg.chat.id);
  });

  bot.onText(/\/add(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) {
      return bot.sendMessage(msg.chat.id, '⛔ Эта команда только для админа.\nПосты можно добавлять на сайте: ' + POSTS_URL);
    }
    const water = (match && match[1] ? match[1] : '').trim();
    if (!water) {
      return bot.sendMessage(msg.chat.id,
        '📝 Укажи водоём: /add оз. Комариное\n\n' +
        'Доступные названия:\n' + WATERS.map(w => '• ' + w).join('\n'));
    }
    const exact = WATERS.find(w => w.toLowerCase() === water.toLowerCase());
    if (!exact) {
      return bot.sendMessage(msg.chat.id,
        '⚠️ Нет водоёма «' + water + '». Пиши точно как в списке:\n' +
        WATERS.map(w => '• ' + w).join('\n'));
    }
    drafts[msg.chat.id] = { water: exact, step: 'photo', photoId: null, caption: '', link: null };
    bot.sendMessage(msg.chat.id,
      '📸 Шаг 1 из 3: отправь <b>фото</b> для поста «' + exact + '».\n' +
      'Нет фото? Напиши /skip — пост будет текстовым.', { parse_mode: 'HTML' });
  });

  bot.onText(/\/list/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return;
    const has = await postsMap();
    const lines = WATERS.map(w => (has[w] ? '✅ ' : '⏳ ') + w);
    bot.sendMessage(msg.chat.id, '📋 <b>Водоёмы:</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.onText(/\/cancel/, async (msg) => {
    if (drafts[msg.chat.id]) {
      delete drafts[msg.chat.id];
      bot.sendMessage(msg.chat.id, '❌ Создание поста отменено.');
    }
  });

  // ---------- Приём сообщений (админ-режим) ----------
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const d = drafts[chatId];
    if (!d || !isAdmin(chatId)) return;
    const text = (msg.text || '').trim();

    if (text === '/skip') {
      if (d.step === 'photo') { d.step = 'caption'; return bot.sendMessage(chatId, '✍️ Шаг 2 из 3: отправь <b>текст поста</b> (до 900 знаков).', { parse_mode: 'HTML' }); }
      if (d.step === 'link') { d.link = null; delete drafts[chatId]; return savePost(chatId, d); }
      return;
    }

    if (d.step === 'photo') {
      const ph = msg.photo;
      if (!ph) return;
      d.photoId = ph[ph.length - 1].file_id;
      d.step = 'caption';
      return bot.sendMessage(chatId, '✅ Фото принято!\n✍️ Шаг 2 из 3: отправь <b>текст поста</b> (до 900 знаков).', { parse_mode: 'HTML' });
    }

    if (d.step === 'caption') {
      if (!text) return;
      d.caption = text.slice(0, 900);
      d.step = 'link';
      return bot.sendMessage(chatId,
        '✅ Текст принят!\n🔗 Шаг 3 из 3: отправь <b>ссылку на пост в канале</b> (или /skip — без ссылки).', { parse_mode: 'HTML' });
    }

    if (d.step === 'link') {
      if (text && !/^https?:\/\//.test(text)) {
        return bot.sendMessage(chatId, '⚠️ Это не похоже на ссылку. Пришли ссылку вида https://t.me/... или /skip.');
      }
      d.link = text || null;
      delete drafts[chatId];
      await savePost(chatId, d);
    }
  });

  // ---------- Кнопки ----------
  bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const msgId = q.message.message_id;
    bot.deleteMessage(chatId, msgId).catch(() => {});
    if (q.data === 'menu') {
      await sendMenu(chatId);
    } else if (q.data && q.data.startsWith('water:')) {
      const idx = parseInt(q.data.slice(6), 10);
      if (!isNaN(idx) && WATERS[idx]) await showPost(chatId, idx);
    }
    bot.answerCallbackQuery(q.id).catch(() => {});
  });

  bot.on('polling_error', (e) => console.log('TG polling: ' + e.message));
}
