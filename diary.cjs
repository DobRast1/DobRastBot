const path = require('path');
const { readJsonSafe, writeJsonSafe } = require('./utils.cjs');
const DIARY_FILE = path.join(__dirname, 'diary.json');
const START_DATE = new Date('2024-01-01');

const MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4,
    "мая": 5, "июня": 6, "июля": 7, "августа": 8,
    "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12
};

const PLANTS = [
    "лимон", "гранат", "киви", "актинидия", "клубника", "малина",
    "смородина", "шиповник", "фундук", "алоэ", "декабрист", "кактус",
    "фикус", "орхидея", "роза", "помидор", "огурец", "перец",
    "базилик", "мята", "петрушка", "укроп", "патиссон", "арбуз"
];

function loadDiary() {
    return readJsonSafe(DIARY_FILE, []);
}

function saveDiary(records) {
    writeJsonSafe(DIARY_FILE, records);
}

// Проверка, что дата YYYY-MM-DD реально существует и не в будущем
function isValidDateStr(dateStr) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
    const [y, m, d] = dateStr.split('-').map(Number);
    const parsed = new Date(y, m - 1, d);
    if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) return false;
    if (parsed < START_DATE) return false;
    if (parsed > new Date()) return false;
    return true;
}

function checkDate(text) {
    const lowerText = text.toLowerCase();
    let day = null, month = null;
    for (const [mName, mNum] of Object.entries(MONTHS)) {
        if (lowerText.includes(mName)) { month = mNum; break; }
    }
    if (!month) return { ok: true };

    const dayMatch = lowerText.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/);
    if (!dayMatch) return { ok: true };
    day = parseInt(dayMatch[1], 10);

    const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
    const testDate = new Date(year, month - 1, day);

    if (testDate.getDate() !== day || testDate.getMonth() !== month - 1) {
        return { ok: false, error: `Такого числа нет: ${day} ${Object.keys(MONTHS)[month - 1]} ${year}` };
    }
    if (testDate < START_DATE) return { ok: false, error: "Эта дата раньше, чем я появился." };
    if (testDate > new Date()) return { ok: false, error: "Эта дата ещё не наступила." };
    return { ok: true };
}

function addRecord(userId, text, dateStr, plantName = null) {
    if (!isValidDateStr(dateStr)) {
        return `Ошибка: дата «${dateStr}» невалидна. Использую сегодняшнюю.`;
    }

    const records = loadDiary();
    let foundPlant = plantName;

    if (!foundPlant) {
        const lowerText = String(text).toLowerCase();
        for (const p of PLANTS) {
            if (lowerText.includes(p)) { foundPlant = p; break; }
        }
    }
    if (!foundPlant) foundPlant = "растение";

    const displayPlant = foundPlant.charAt(0).toUpperCase() + foundPlant.slice(1);

    records.push({
        id: Date.now(),
        userId: userId,
        date: dateStr,
        plant: displayPlant,
        note: text
    });
    saveDiary(records);
    return `📝 Записал на ${dateStr}: ${displayPlant} — ${text}`;
}

function getAvailableDates(userId) {
    const allRecords = loadDiary();
    const userRecords = allRecords.filter(r => String(r.userId) === String(userId));
    if (userRecords.length === 0) return "Дневник пока пуст.";

    const dates = [...new Set(userRecords.map(r => r.date))].sort().reverse();
    let result = "📅 Твой дневник. Выбери дату:\n\n";
    dates.forEach(d => {
        const formattedDate = new Date(d).toLocaleDateString('ru-RU', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        result += `📌 ${formattedDate}\n`;
    });
    return result;
}

function getRecordsByDate(userId, dateStr) {
    const allRecords = loadDiary();
    const records = allRecords.filter(r =>
        String(r.userId) === String(userId) && r.date === dateStr
    );
    if (records.length === 0) return "На эту дату записей нет.";

    const formattedDate = new Date(dateStr).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric'
    });

    let result = `📝 Записи за ${formattedDate}:\n\n`;
    records.forEach((r, i) => {
        result += `${i + 1}. ${r.plant}: ${r.note}\n`;
    });
    return result;
}

function deleteRecord(userId, dateStr, index) {
    let allRecords = loadDiary();
    const dayRecords = allRecords.filter(r =>
        String(r.userId) === String(userId) && r.date === dateStr
    );
    if (index < 1 || index > dayRecords.length) return "Ошибка: записи с таким номером не существует.";

    const recordToDelete = dayRecords[index - 1];
    allRecords = allRecords.filter(r => r.id !== recordToDelete.id);
    saveDiary(allRecords);
    return `🗑️ Запись №${index} за ${dateStr} удалена.`;
}

function editRecord(userId, dateStr, index, newText) {
    const allRecords = loadDiary();
    const dayRecords = allRecords.filter(r =>
        String(r.userId) === String(userId) && r.date === dateStr
    );
    if (index < 1 || index > dayRecords.length) return "Ошибка: записи с таким номером не существует.";

    const recordToEdit = dayRecords[index - 1];
    allRecords.forEach(r => {
        if (r.id === recordToEdit.id) r.note = newText;
    });
    saveDiary(allRecords);
    return `✏️ Запись №${index} за ${dateStr} обновлена.`;
}

// Точное сравнение действия, а не поиск подстроки в note
function checkDangerousAction(chatId, action, dateStr, plant) {
    if (!action) return null;

    const rules = [
        { re: /^подкормка$/i, days: 14, limit: 1, msg: 'Слишком часто подкармливать нельзя — это ожог корней и перекорм. Подкормки делают примерно раз в 1–2 недели и только в сезон роста. Лучше пропустить, чем переборщить.' },
        { re: /^пересадка$/i, days: 60, limit: 1, msg: 'Пересадка — большой стресс для растения. Обычно её делают раз в 1–2 года весной. Повторная пересадка через пару месяцев растение может не пережить.' },
        { re: /^обрезка$/i, days: 1, limit: 1, msg: 'Много резать за один день вредно — растение тратит силы на заживление срезов. Остальное лучше отложить на потом.' },
        { re: /^обработка$/i, days: 5, limit: 1, msg: 'Обработки от вредителей нельзя проводить каждый день — можно сжечь листья. Обычно повторяют через 5–7 дней.' }
    ];

    for (const rule of rules) {
        if (!rule.re.test(String(action).trim())) continue;

        const diary = loadDiary();
        const dateMs = new Date(dateStr + 'T00:00:00').getTime();
        const windowStart = dateMs - rule.days * 24 * 60 * 60 * 1000;

        const same = diary.filter(r => {
            if (String(r.userId) !== String(chatId)) return false;
            // сравниваем точное действие, а не подстроку
            if (!rule.re.test(String(r.note || '').trim())) return false;
            if (plant && r.plant && String(r.plant).toLowerCase() !== plant.toLowerCase()) return false;
            const d = new Date(String(r.date || '') + 'T00:00:00').getTime();
            return !isNaN(d) && d >= windowStart && d <= dateMs;
        });

        if (same.length >= rule.limit) return rule.msg;
    }
    return null;
}

module.exports = {
    loadDiary, saveDiary, checkDate, addRecord,
    getAvailableDates, getRecordsByDate, deleteRecord, editRecord,
    checkDangerousAction
};
