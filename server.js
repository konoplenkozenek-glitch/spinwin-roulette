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
const DA_CUTOFF_HOURS = 24;  // обрабатывать только донаты за последние N часов

const PACKAGES = [
  { amount: 100,  spins: 1 },
  { amount: 300,  spins: 4 },
  { amount: 1000, spins: 13 }
];

// ====== СПИСОК НАГРАД (выпадает при взрыве) ======
const PRIZES = [
  { name: 'Любая наживка 5 шт',   color: '#ffcf40', chance: 6.65 },
  { name: 'Приманки на выбор',    color: '#4caf50', chance: 6.65 },
  { name: '1 бутылка алкоголя',   color: '#ef4444', chance: 6.65 },
  { name: 'Кофе 500',             color: '#d2a24c', chance: 6.65 },
  { name: 'Кофе 1000',            color: '#b78cff', chance: 6.65 },
  { name: 'Золотая монета 1 шт',  color: '#ffa726', chance: 6.65 },
  { name: 'Премиум 3 дня',        color: '#4db8ff', chance: 5 },
  { name: 'Майка 10 шт',          color: '#ff6ec7', chance: 6.65 },
  { name: 'Нос 10 шт',            color: '#9e9e9e', chance: 6.65 },
  { name: 'Бокоплав 10 шт',       color: '#7ec84a', chance: 6.65 },
  { name: 'Медведка 10 шт',       color: '#7ec84a', chance: 6.65 },
  { name: 'Дрейсена 10 шт',       color: '#4db8ff', chance: 6.65 },
  { name: 'Перловица 10 шт',      color: '#b78cff', chance: 6. abuse 10 шт' : '#7ec84a' },
  { name: 'Сбитень 10 шт',        color: '#ff7043', chance: 6.65 },
  { name: 'Золотая монетка 2 шт', color: '#ffd54f', chance: 5 },
  { name: 'Премиум 7 дней',       color: '#4db8ff', chance: 3 },
  { name: 'Премиум 30 дней',      color: '#4caf50', chance: 0.5 },
  { name: 'Venga II 10k',         color: '#ffd54f', chance: 0.001 }
];

function prizeColor(name) {
  const p = PRIZES.find(x => x.name === name);
  return p ? p.color : '#FFD700';
}

// выбор приза по шансам (в процентах)
function pickPrize() {
  const total = PRIZES.reduce((s, p) => s + p.chance, 0);
  let r = Math.random() * total;
  for (const p of PRIZES) {
    r -= p.chance;
    if (r <= 0) return p;
  }
  return PRIZES[PRIZES.length - 1];
}
// ======================================

// ====== ХЕЛПЕРЫ ======
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = working version;
