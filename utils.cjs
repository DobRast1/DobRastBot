const fs = require('fs');

function readJsonSafe(filePath, defaultVal = []) {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (!content) return defaultVal;
        return JSON.parse(content);
    } catch (error) {
        console.error(`Ошибка чтения ${filePath}:`, error.message);
        return defaultVal;
    }
}

function writeJsonSafe(filePath, data) {
    const tmpFile = filePath + '.tmp';
    try {
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmpFile, filePath);
    } catch (error) {
        console.error(`Ошибка записи ${filePath}:`, error.message);
        try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
}

module.exports = { readJsonSafe, writeJsonSafe };