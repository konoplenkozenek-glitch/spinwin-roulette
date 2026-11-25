// === Золотая Удача: вся логика мини-приложения ===

const DONATE_URL = 'https://www.donationalerts.com/r/evgeniy_2026';
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const elResult = document.getElementById('result');
const elBalance = document.getElementById('balance');
const elSpinBtn = document.getElementById('spinBtn');
const modal = document.getElementById('winModal');
const winTitle = document.getElementById('winTitle');
const closeModalBtn = document.getElementById('closeModalBtn');

const bombStage = document.getElementById('bombStage');
const bombWrap = document.getElementById('bombWrap');
const flash = document.getElementById('flash');
const shockwave = document.getElementById('shockwave');

const promoInput = document.getElementById('promoInput');
const promoBtn = document.getElementById('promoBtn');
const promoMsg = document.getElementById('promoMsg');

let gameNickSaved = localStorage.getItem('gameNick') || '';

document.getElementById('donateBtn').href = DONATE_URL;

/* ============ ФОНОВЫЕ ЧАСТИЦЫ ============ */
function createParticles() {
  const container = document.getElementById('bg-particles');
  for (let i = 0; i < 20; i++) {
    let p = document.createElement('div');
    p.style.position = 'absolute';
    p.style.width = p.style.height = Math.random() * 4 + 1 + 'px';
    p.style.background = '#FFD700';
    p.style.borderRadius = '50%';
    p.style.opacity = Math.random() * 0.5 + 0.2;
    p.style.left = Math.random() * 100 + '%';
    p.style.top = Math.random() * 100 + '%';
    p.style.boxShadow = '0 0 10px #FFD700';
    p.animate([{ transform: 'translateY(0px)' }, { transform: `translateY(-${Math.random() * 200 + 100}px)` }], {
      duration: Math.random() * 5000 + 3000, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out'
    });
    container.appendChild(p);
  }
}
createParticles();

/* ============ ПРИЗЫ ============ */
async function loadPrizes() {
  try {
    const r = await fetch('/api/prizes');
    const j = await r.json();
    if (j.ok) {
      document.getElementById('prizeList').innerHTML =
        j.prizes.map(p => `<li style="color:${p.color}">${p.label}</li>`).join('');
    }
  } catch (e) { }
}

/* ============ БАЛАНС ============ */
async function loadBalance() {
  const MAX = 3;
  for (let i = 1; i <= MAX; i++) {
    elBalance.textContent = `Загружаем... (${i}/${MAX})`;
    try {
      const r = await fetch('/api/me', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData || '', gameNick: gameNickSaved })
      });
      const j = await r.json();
      if (j.ok) {
        if (!j.gameNick && !gameNickSaved) {
          const nick = prompt('Введи свой игровой ник (для выдачи призов):', '');
          if (nick && nick.trim()) {
            gameNickSaved = nick.trim();
            localStorage.setItem('gameNick', gameNickSaved);
            fetch('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData || '', gameNick: gameNickSaved }) });
          }
        }
        elBalance.innerHTML = `Привет, <b>${j.name}</b>!<br>Взрывов: <b style="color:#FFD700">${j.spins}</b>` + (gameNickSaved ? `<br>Ник: ${gameNickSaved}` : '');
        return;
      }
    } catch (e) { }
    await new Promise(r => setTimeout(r, 1500));
  }
  elBalance.textContent = '⚠️ Сервер спит. Нажми «Взорвать!», чтобы разбудить.';
}

async function changeNick() {
  const nick = prompt('Введи НОВЫЙ игровой ник:', gameNickSaved || '');
  if (nick === null) return;
  const trimmed = nick.trim();
  if (!trimmed) return alert('Ник не может быть пустым.');
  gameNickSaved = trimmed;
  localStorage.setItem('gameNick', gameNickSaved);
  try {
    await fetch('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData || '', gameNick: gameNickSaved }) });
    alert(`Ник обновлён: ${gameNickSaved}`);
  } catch (e) { alert('Сохранено локально.'); }
  loadBalance();
}

/* ============ ПРОМОКОД ============ */
async function redeemPromo() {
  const code = promoInput.value.trim().toUpperCase();
  if (!code) {
    promoMsg.textContent = 'Введи промокод из чата.';
    promoMsg.className = 'promo-msg err';
    return;
  }

  promoBtn.disabled = true;
  promoMsg.textContent = '';
  try {
    const r = await fetch('/api/redeem-promo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData || '', code })
    });
    const j = await r.json();

    if (j.ok) {
      promoMsg.textContent = '🎟 Есть! Взрыв зачислен.';
      promoMsg.className = 'promo-msg ok';
      promoInput.value = '';
      loadBalance();
    } else if (j.error === 'used') {
      promoMsg.textContent = '😔 Код уже кто-то забрал.';
      promoMsg.className = 'promo-msg err';
    } else if (j.error === 'not_found') {
      promoMsg.textContent = '❌ Такого кода нет.';
      promoMsg.className = 'promo-msg err';
    } else {
      promoMsg.textContent = '⚠️ Ошибка, попробуй позже.';
      promoMsg.className = 'promo-msg err';
    }
  } catch (e) {
    promoMsg.textContent = '⚠️ Ошибка соединения.';
    promoMsg.className = 'promo-msg err';
  }
  promoBtn.disabled = false;
}

/* Enter в поле промокода = нажать кнопку */
promoInput.addEventListener('keydown', e => { if (e.key === 'Enter') redeemPromo(); });

/* ============ ВЗРЫВ ============ */
const ARM_TIME = 3000; // сколько мс бомба "шипит" перед взрывом

function resetBomb() {
  bombWrap.classList.remove('boom', 'dud');
  bombStage.classList.remove('arming', 'shaking');
}

async function spin() {
  elResult.style.display = 'none';
  elSpinBtn.disabled = true;
  resetBomb();

  // Запрос улетает сразу, анимация идёт параллельно
  const fetchPromise = (async () => {
    try {
      const r = await fetch('/api/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData || '' })
      });
      return await r.json();
    } catch (e) {
      return { error: 'network' };
    }
  })();

  // Фаза 1: фитиль горит, бомба трясётся
  bombStage.classList.add('arming');

  const j = await fetchPromise;

  setTimeout(() => {
    if (j.ok) {
      explode(j);
    } else {
      dud(j);
    }
  }, ARM_TIME);
}

function explode(j) {
  bombStage.classList.remove('arming');
  bombStage.classList.add('shaking');
  bombWrap.classList.add('boom');

  // Вспышка
  flash.classList.add('on');
  setTimeout(() => flash.classList.remove('on'), 600);

  // Ударная волна
  shockwave.classList.add('go');
  setTimeout(() => shockwave.classList.remove('go'), 900);

  // Конфетти в два залпа
  confetti({ particleCount: 200, spread: 120, origin: { y: 0.5 }, colors: ['#FFD700', '#FF4500', '#FFFFFF', '#FF8C00'] });
  setTimeout(() => {
    confetti({ particleCount: 120, spread: 160, origin: { y: 0.4 }, colors: ['#FFD700', '#FF4500', '#FFFFFF'] });
  }, 250);

  const serverPrizeName = j.prize.label;

  elResult.className = 'result win';
  elResult.innerHTML = `🎁 Выпало: <b>${serverPrizeName}</b><br>Осталось взрывов: <b>${j.spinsLeft}</b><br><small>Сделай скриншот и отправь админу!</small>`;

  // Модалка с призом — чуть позже взрыва
  setTimeout(() => {
    winTitle.innerText = serverPrizeName;
    modal.style.display = 'flex';
    elResult.style.display = 'block';
    elSpinBtn.disabled = false;
    resetBomb();
    loadBalance();
  }, 900);
}

function dud(j) {
  bombStage.classList.remove('arming');
  bombWrap.classList.add('dud');

  let msg;
  if (j.error === 'no_spins') {
    msg = `😕 Бомба не взорвалась — нет взрывов.<br>Задонать 100 ₽ = 1 взрыв!`;
  } else if (j.error === 'network') {
    msg = '⚠️ Ошибка сети.';
  } else {
    msg = `⚠️ ${j.message || j.error}`;
  }

  elResult.className = 'result fail';
  elResult.innerHTML = msg;
  elResult.style.display = 'block';
  elSpinBtn.disabled = false;
  loadBalance();
}

closeModalBtn.addEventListener('click', () => {
  modal.style.display = 'none';
});

loadPrizes();
loadBalance();
