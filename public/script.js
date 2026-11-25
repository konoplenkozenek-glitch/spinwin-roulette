// ВАЖНО: Проверьте названия файлов! Они должны быть точно такими же, как в папке images.
const prizes = [
    { name: 'Кофе за 500', img: 'images/coffee500.png' },
    { name: 'Алкоголь', img: 'images/alcohol.png' },
    { name: 'Выбор байта', img: 'images/bait_choice.png' },
    { name: 'Байт 5', img: 'images/bait5.png' },
    { name: 'Бокоплав 10', img: 'images/bokoplav10.png' },
    // ДОБАВЬТЕ ОСТАЛЬНЫЕ ПРИЗЫ СЮДА (у вас их 18):
    // { name: 'Название', img: 'images/имя_файла.png' },
    // { name: 'Название', img: 'images/имя_файла.png' },
];

const colors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#1A535C', '#FF9F1C', '#2EC4B6'];

const wheel = document.getElementById('wheel');
const spinBtn = document.getElementById('spinBtn');
const modal = document.getElementById('winModal');
const winTitle = document.getElementById('winTitle');
const winImage = document.getElementById('winImage');
const closeModalBtn = document.getElementById('closeModalBtn');

let isSpinning = false;
let currentRotation = 0;

function drawWheel() {
    const totalPrizes = prizes.length;
    const anglePerPrize = 360 / totalPrizes;
    
    let gradientStr = [];
    
    prizes.forEach((prize, index) => {
        const startAngle = index * anglePerPrize;
        const endAngle = (index + 1) * anglePerPrize;
        const color = colors[index % colors.length];
        
        gradientStr.push(`${color} ${startAngle}deg ${endAngle}deg`);
        
        const textElement = document.createElement('div');
        textElement.style.position = 'absolute';
        textElement.style.width = '50%';
        textElement.style.height = '50%';
        textElement.style.left = '50%';
        textElement.style.top = '0';
        textElement.style.transformOrigin = '0% 100%';
        textElement.style.transform = `rotate(${startAngle + (anglePerPrize / 2)}deg)`;
        textElement.style.display = 'flex';
        textElement.style.justifyContent = 'center';
        textElement.style.alignItems = 'center';
        textElement.style.fontSize = '12px';
        textElement.style.fontWeight = 'bold';
        textElement.style.color = '#000';
        textElement.style.textShadow = '1px 1px 2px rgba(255,255,255,0.5)';
        textElement.style.pointerEvents = 'none';
        textElement.style.paddingTop = '20px'; 
        
        textElement.innerText = prize.name;
        wheel.appendChild(textElement);
    });

    wheel.style.background = `conic-gradient(${gradientStr.join(', ')})`;
}

spinBtn.addEventListener('click', () => {
    if (isSpinning) return;
    isSpinning = true;
    spinBtn.disabled = true;

    const winnerIndex = Math.floor(Math.random() * prizes.length);
    const anglePerPrize = 360 / prizes.length;
    
    const randomOffset = (Math.random() * anglePerPrize * 0.8) - (anglePerPrize * 0.4);
    const targetAngle = 360 - (winnerIndex * anglePerPrize) - (anglePerPrize / 2) + randomOffset;

    const spins = 5;
    const totalRotation = currentRotation + (360 * spins) + targetAngle;

    wheel.style.transform = `rotate(${totalRotation}deg)`;
    currentRotation = totalRotation;

    setTimeout(() => {
        const wonPrize = prizes[winnerIndex];
        
        winTitle.innerText = wonPrize.name;
        winImage.src = wonPrize.img;
        
        modal.style.display = 'flex';
        
        isSpinning = false;
        spinBtn.disabled = false;
    }, 5000);
});

closeModalBtn.addEventListener('click', () => {
    modal.style.display = 'none';
});

drawWheel();
