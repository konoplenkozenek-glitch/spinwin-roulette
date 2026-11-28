// ====== БОТ «ПОСТЫ РР4» ======
const TelegramBot = require('node-telegram-bot-api');
const TOKEN = process.env.POSTS_BOT_TOKEN; // токен из Render (Environment)

// ================================================================
//  ВОДОЁМЫ И ССЫЛКИ НА ПОСТЫ
//  url: ссылка на пост про водоём (кнопка «Копировать ссылку» в TG).
//  Пока поста нет — оставь '', кнопка покажет «скоро появится».
// ================================================================
const WATERS = [
  { name: 'оз. Комариное',      url: '' },
  { name: 'оз. Лосиное',        url: '' },
  { name: 'р. Вьюнок',          url: '' },
  { name: 'оз. Старый Острог',  url: '' },
  { name: 'р. Белая',           url: '' },
  { name: 'оз. Куори',          url: '' },
  { name: 'оз. Медвежье',       url: '' },
  { name: 'р. Волхов',          url: '' },
  { name: 'р. Северский Донец', url: '' },
  { name: 'р. Сура',            url: '' },
  { name: 'Ладожское оз.',      url: '' },
  { name: 'оз. Янтярное',       url: '' },
  { name: 'р. Ахтуба',          url: '' },
  { name: 'оз. Медное',         url: '' },
  { name: 'р. Нижняя Тунгуска', url: '' },
  { name: 'р. Яма',             url: '' },
  { name: 'Норвежское море',    url: '' }
];

if (!TOKEN) {
  console.error('Нет POSTS_BOT_TOKEN — бот не запущен');
} else {
  const bot = new TelegramBot(TOKEN, { polling: true });

  // Клавиатура: по 2 кнопки в ряд
  function buildKeyboard() {
    const rows = [];
    for (let i = 0; i < WATERS.length; i += 2) {
      const row = [];
      WATERS.slice(i, i + 2).forEach((w, idx) => {
        const n = i + idx;
        if (w.url) {
          row.push({ text: w.name, url: w.url });
        } else {
          row.push({ text: w.name + ' ⏳', callback_data: 'soon:' + n });
        }
      });
      rows.push(row);
    }
    return rows;
  }

  const MENU_TEXT = '🎣 Посты РР4\n\nВыбери водоём — откроется пост про него. Пометка ⏳ значит, что пост скоро появится.';

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, MENU_TEXT, {
      reply_markup: { inline_keyboard: buildKeyboard() }
    });
  });

  bot.on('callback_query', (q) => {
    if (q.data && q.data.startsWith('soon:')) {
      const n = parseInt(q.data.slice(5), 10);
      const w = WATERS[n];
      if (w) bot.answerCallbackQuery(q.id, { text: 'Пост про «' + w.name + '» скоро появится ⏳', show_alert: false });
    }
  });

  console.log('Бот постов запущен');
}
