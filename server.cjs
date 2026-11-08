const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = 3000;

app.use(express.json());
// Раздаем статические файлы (index.html) из текущей папки
app.use(express.static(__dirname));

// API для получения записей
app.get('/api/notes', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'No userId' });
    
    const diary = JSON.parse(fs.readFileSync(path.join(__dirname, 'diary.json'), 'utf8') || '[]');
    const userNotes = diary.filter(r => String(r.userId) === String(userId));
    res.json(userNotes);
});

// API для добавления записи с сайта
app.post('/api/notes', (req, res) => {
    const { userId, plant, note, date } = req.body;
    if (!userId) return res.status(400).json({ error: 'No userId' });

    const diary = JSON.parse(fs.readFileSync(path.join(__dirname, 'diary.json'), 'utf8') || '[]');
    
    // Приводим дату из формата сайта (ДД.ММ.ГГГГ) в формат базы (ГГГГ-ММ-ДД)
    let dbDate = date;
    if (date.includes('.')) {
        const [d, m, y] = date.split('.');
        dbDate = `${y}-${m}-${d}`;
    }

    diary.push({
        id: Date.now(),
        userId: userId,
        date: dbDate,
        plant: plant || 'Растение',
        note: note
    });

    fs.writeFileSync(path.join(__dirname, 'diary.json'), JSON.stringify(diary, null, 2));
    res.json({ success: true });
});

// Отдаем index.html на главную
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const currentPort = process.env.PORT || PORT;
app.listen(currentPort, '0.0.0.0', () => {
    console.log(`🚀 Веб-сервер запущен на порту: ${currentPort}`);
});
