const path = require('path');
const { readJsonSafe, writeJsonSafe } = require('./utils.cjs');
const PLANTS_FILE = path.join(__dirname, 'plants.json');

function loadPlants() {
    return readJsonSafe(PLANTS_FILE, []);
}

function savePlants(plants) {
    writeJsonSafe(PLANTS_FILE, plants);
}

function pluralDays(n) {
    const last = n % 10;
    const lastTwo = n % 100;
    if (lastTwo >= 11 && lastTwo <= 14) return 'дней';
    if (last === 1) return 'день';
    if (last >= 2 && last <= 4) return 'дня';
    return 'дней';
}

function capitalize(name) {
    return String(name || '').charAt(0).toUpperCase() + String(name || '').slice(1);
}

function nameStem(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^а-яa-z0-9]/g, '')
        .slice(0, 5);
}

function isSamePlant(a, b) {
    const sa = nameStem(a), sb = nameStem(b);
    if (!sa || !sb) return false;
    if (sa === sb) return true;
    return sa.startsWith(sb) || sb.startsWith(sa);
}

function findPlant(userId, name) {
    return loadPlants().find(p => String(p.userId) === String(userId) && isSamePlant(p.name, name)) || null;
}

function plantsListText(userId) {
    const list = loadPlants().filter(p => String(p.userId) === String(userId));
    return list.map(p => capitalize(p.name)).join(', ') || 'пока ничего 🌵';
}

const HOME_WORDS = ['дом', 'квартир', 'комнат', 'подокон', 'кухн', 'балкон',
    'лоджи', 'спальн', 'зал', 'гостин', 'кабинет', 'офис', 'коридор', 'оранжер'];
const OUT_WORDS = ['улиц', 'огород', 'сад', 'дач', 'теплиц', 'грядк', 'двор', 'террас'];

function detectPlace(location) {
    const loc = String(location || '').toLowerCase().replace(/ё/g, 'е');
    if (!loc.trim()) return null;
    if (OUT_WORDS.some(w => loc.includes(w))) return 'улица';
    if (HOME_WORDS.some(w => loc.includes(w))) return 'дома';
    return null;
}

function defaultInterval(lowerName, place) {
    if (place === 'дома') {
        if (/кактус|суккулент|алоэ/.test(lowerName)) return 14;
        if (/фикус|герань|орхиде/.test(lowerName)) return 7;
        if (/лимон|гранат|фиалка/.test(lowerName)) return 3;
        return 5;
    }
    if (/помидор|огурец|клубник|перец/.test(lowerName)) return 2;
    return 3;
}

//Правильно склоняем прилагательные и существительные
function tryFixName(name) {
    if (!name) return 'Растение';
    
    // Отделяем сорт в кавычках, чтобы не трогать латиницу
    const match = name.match(/^(.+?)(\s*«.+»)?$/);
    if (!match) return name;
    
    let mainPart = match[1].trim();
    const sortPart = match[2] || ''; 

    const words = mainPart.split(/\s+/);
    const fixedWords = words.map((word, index) => {
        if (/[a-z0-9]/i.test(word)) return word;
        
        let n = word.toLowerCase();
        
        // 1. Прилагательные (пурпурную -> пурпурная, синюю -> синяя)
        if (n.endsWith('ую') || n.endsWith('юю')) {
            n = n.slice(0, -2) + (n.endsWith('юю') ? 'яя' : 'ая');
        }
        // 2. Прилагательные (пурпурного -> пурпурный)
        else if (n.endsWith('ого') || n.endsWith('его')) {
            n = n.slice(0, -3) + 'ый';
        }
        // 3. Прилагательные на -ая/-яя (высокая -> высокая)
        else if (n.endsWith('ую')) {
            n = n.slice(0, -2) + 'ая';
        }
        // 4. Существительные женского рода (наперстянку -> наперстянка)
        else if (n.endsWith('у') || n.endsWith('ю')) {
            n = n.slice(0, -1) + 'а';
        }
        // 5. Творительный падеж (розой -> роза)
        else if (n.endsWith('ой') || n.endsWith('ей')) {
            n = n.slice(0, -2) + 'а';
        }
        
        // Делаем первую букву заглавной только у первого слова
        if (index === 0) {
            return n.charAt(0).toUpperCase() + n.slice(1);
        }
        return n;
    });

    return fixedWords.join(' ') + sortPart;
}

function addPlant(userId, name, location, lastWatered) {
    const plants = loadPlants();
    const fixedName = tryFixName(name);
    const lowerName = String(fixedName).toLowerCase().replace(/ё/g, 'е').trim();

    let place = detectPlace(location);
    let note = '';
    if (!place) {
        place = 'дома';
        if (location && String(location).trim()) {
            note = ` Место «${location}» не понял, записал как «дома» — поменять можно словами: «поменяй место у ${fixedName}».`;
        }
    }

    const days = defaultInterval(lowerName, place);

    const nextDate = new Date(lastWatered);
    nextDate.setDate(nextDate.getDate() + days);

    const newPlant = {
        userId: userId,
        id: Date.now(),
        name: fixedName,
        location: place,
        lastWatered: lastWatered,
        daysInterval: days,
        nextWatering: nextDate.toISOString(),
        schedule: {
            water: { intervalDays: days, source: 'default', confirmed: true },
            fertilize: { intervalDays: 14, source: 'default', confirmed: true },
            loosen: { intervalDays: 14, source: 'default', confirmed: true },
            spray: { intervalDays: 3, source: 'default', confirmed: true }
        }
    };

    plants.push(newPlant);
    savePlants(plants);

    // Возвращаем объект с текстом, чтобы бот не выводил [object Object]
    return {
        text: `✅ Отлично! Записал: **${capitalize(newPlant.name)}** (${place}).${note}`,
        plantName: newPlant.name,
        location: place
    };
}

function waterPlant(userId, name) {
    const plants = loadPlants();
    const p = plants.find(x => String(x.userId) === String(userId) && isSamePlant(x.name, name));

    if (!p) {
        return `Не нашёл растение «${name}» в списке. Что есть: ${plantsListText(userId)}.`;
    }

    p.lastWatered = new Date().toISOString();
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + p.daysInterval);
    p.nextWatering = nextDate.toISOString();
    savePlants(plants);

    return `Красавчик! Отметил полив: **${capitalize(p.name)}**. Следующее напоминание будет позже. 🌿`;
}

function showPlants(userId) {
    const allPlants = loadPlants();
    const plants = allPlants.filter(p => String(p.userId) === String(userId));

    if (plants.length === 0) return "У тебя пока нет растений. Нажми кнопку ниже, чтобы добавить первое! 🌿";

    let result = "🌿 **Твои растения:**\n\n";
    plants.forEach(p => {
        const loc = p.location === 'дома' ? '🏠 Дома' : '🌤 На улице';
        result += `🌱 **${capitalize(p.name)}**\n📍 ${loc} • 💧 Полив раз в ${p.daysInterval} ${pluralDays(p.daysInterval)}\n\n`;
    });
    return result;
}

function editPlant(userId, oldName, newName, newLocation) {
    const plants = loadPlants();
    const p = plants.find(x => String(x.userId) === String(userId) && isSamePlant(x.name, oldName));

    if (!p) return `Не нашёл растение «${oldName}» в списке. Что есть: ${plantsListText(userId)}.`;

    p.name = tryFixName(newName);
    if (newLocation) {
        const place = detectPlace(newLocation);
        p.location = place || p.location;
        p.daysInterval = defaultInterval(String(p.name).toLowerCase().replace(/ё/g, 'е'), p.location);
        const nextDate = new Date(p.lastWatered);
        nextDate.setDate(nextDate.getDate() + p.daysInterval);
        p.nextWatering = nextDate.toISOString();
    }
    savePlants(plants);
    return `✏️ Обновил! Теперь это **${capitalize(p.name)}** (${p.location}).`;
}

function deletePlant(userId, name) {
    const allPlants = loadPlants();
    const p = allPlants.find(x => String(x.userId) === String(userId) && isSamePlant(x.name, name));

    if (!p) return `Не нашёл растение «${name}» в списке. Что есть: ${plantsListText(userId)}.`;

    savePlants(allPlants.filter(x => String(x.id) !== String(p.id)));
    return `🗑️ Удалил **${capitalize(p.name)}** из твоего списка.`;
}

function generateReport(userId) {
    const allPlants = loadPlants();
    const plants = allPlants.filter(p => String(p.userId) === String(userId));

    const allDiary = readJsonSafe(path.join(__dirname, 'diary.json'), []);
    const diaryRecords = allDiary.filter(r => String(r.userId) === String(userId));

    const today = new Date().toLocaleDateString('ru-RU');

    let report = `📊 **ОТЧЕТ ПО РАСТЕНИЯМ**\n`;
    report += `*Дата: ${today}*\n\n`;

    report += `🌿 **Мои растения (${plants.length}):**\n`;
    if (plants.length === 0) {
        report += `• Пока нет добавленных растений.\n`;
    } else {
        plants.forEach(p => {
            const loc = p.location === 'дома' ? '🏠' : '🌤';
            report += `• **${capitalize(p.name)}** (${loc}) — полив раз в ${p.daysInterval} ${pluralDays(p.daysInterval)}.\n`;
        });
    }
    report += `\n`;

    report += `📝 **Последние наблюдения:**\n`;
    if (diaryRecords.length === 0) {
        report += `• Записей в дневнике пока нет.\n`;
    } else {
        const recent = diaryRecords.slice(-3).reverse();
        recent.forEach(r => {
            const shortDate = r.date ? r.date.split(',')[0] : 'Неизвестно';
            report += `• ${shortDate}: ${r.note}.\n`;
        });
    }
    report += `\n`;

    report += `🤖 **Совет от ДобРаста:**\n`;
    if (plants.length === 0) {
        report += `*«С чего начнем? Добавь свое первое растение!»*`;
    } else {
        let oldest = plants[0];
        plants.forEach(p => { if (new Date(p.lastWatered) < new Date(oldest.lastWatered)) oldest = p; });
        const daysAgo = Math.floor((new Date() - new Date(oldest.lastWatered)) / (1000 * 60 * 60 * 24));
        if (daysAgo > 3) report += `*«Обрати внимание на **${capitalize(oldest.name)}** — он не видел воды уже ${daysAgo} дн.!»*`;
        else report += `*«Твои растения выглядят ухоженными! Продолжай в том же духе.»*`;
    }
    return report;
}

module.exports = { 
    addPlant, 
    waterPlant, 
    showPlants, 
    generateReport, 
    editPlant, 
    deletePlant, 
    findPlant, 
    isSamePlant, 
    plantsListText,
    loadPlants,
    savePlants
};
