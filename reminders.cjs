const path = require('path');
const { readJsonSafe, writeJsonSafe } = require('./utils.cjs');

const DATA_FILE = path.join(__dirname, 'reminders.json');
const PLANTS_FILE = path.join(__dirname, 'plants.json');
const DAY = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT = 2147483000;

const DEFAULT_QUIET = { from: '22:00', to: '08:00' };

const ACTIONS = {
    water:     { emoji: '💧', verb: 'полить',     what: 'полива' },
    fertilize: { emoji: '🌱', verb: 'подкормить', what: 'подкормки' },
    loosen:    { emoji: '🪴', verb: 'рыхлить',    what: 'рыхления' },
    spray:     { emoji: '💦', verb: 'опрыскать',  what: 'опрыскивания' }
};

function loadState() {
    const data = readJsonSafe(DATA_FILE, null);
    if (Array.isArray(data)) {
        return {
            once: data
                .filter(r => r && r.at && r.text)
                .map((r, i) => ({
                    id: String(r.id ?? `legacy_${i}_${r.at}`),
                    chatId: r.chatId != null ? String(r.chatId) : null,
                    at: r.at,
                    text: r.text
                })),
            schedules: [],
            quiet: {}
        };
    }
    if (data && Array.isArray(data.once)) {
        return {
            once: data.once.map((r, i) => ({
                id: String(r.id ?? `missed_${i}_${r.at}`),
                chatId: r.chatId != null ? String(r.chatId) : null,
                at: r.at,
                text: r.text
            })),
            schedules: (data.schedules || []).map(s => ({
                ...s,
                chatId: s.chatId != null ? String(s.chatId) : null,
                // ИСПРАВЛЕНО: сохраняем plantId, если он есть
                plantId: s.plantId != null ? String(s.plantId) : null
            })),
            quiet: data.quiet || {}
        };
    }
    return { once: [], schedules: [], quiet: {} };
}

function saveState(st) { writeJsonSafe(DATA_FILE, st); }

function clearForChat(chatId) {
    const st = loadState();
    st.schedules = st.schedules.filter(s => String(s.chatId) !== String(chatId));
    st.once = st.once.filter(r => String(r.chatId) !== String(chatId));
    saveState(st);
}

function readPlants(chatId) {
    const data = readJsonSafe(PLANTS_FILE, []);
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.plants) ? data.plants : []);
    return chatId ? list.filter(p => String(p.userId) === String(chatId)) : list;
}

function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function quietFor(st, chatId) {
    return st.quiet[String(chatId)] || DEFAULT_QUIET;
}

function isQuiet(st, chatId, d = new Date()) {
    const q = quietFor(st, chatId);
    const a = parseHM(q.from), b = parseHM(q.to);
    if (a === null || b === null) return false;
    const cur = d.getHours() * 60 + d.getMinutes();
    return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

function quietEndTs(st, chatId, d = new Date()) {
    const q = quietFor(st, chatId);
    const b = parseHM(q.to) || 0;
    const t = new Date(d);
    t.setHours(Math.floor(b / 60), b % 60, 0, 0);
    if (t.getTime() <= d.getTime()) t.setDate(t.getDate() + 1);
    return t.getTime();
}

function parseQuietRange(raw) {
    const norm = String(raw).replace(/[,.]/g, ' ').trim();
    let m = norm.match(/(\d{1,2})[:.](\d{2})\s*(?:-|–|—|до)\s*(\d{1,2})[:.](\d{2})/i);
    if (m) return { from: `${m[1]}:${m[2]}`, to: `${m[3]}:${m[4]}` };
    m = norm.match(/(\d{1,2})\s*(?:ч|час\S*)?\s*(?:-|–|—|до)\s*(\d{1,2})/i);
    if (m) return { from: `${m[1]}:00`, to: `${m[2]}:00` };
    return null;
}

function setQuiet(chatId, from, to) {
    const st = loadState();
    st.quiet[String(chatId)] = { from, to };
    saveState(st);
}

function getQuiet(chatId) { return quietFor(loadState(), chatId); }

function armOnce(send, chatId, rec) {
    if (!rec || !rec.at || !rec.text) return;
    const delay = rec.at - Date.now();
    if (delay <= 0) {
        const st = loadState();
        st.once = st.once.filter(r => String(r.id) !== String(rec.id));
        saveState(st);
        return;
    }
    const timer = setTimeout(() => {
        const st = loadState();
        let sendAt = Date.now();
        if (isQuiet(st, chatId)) sendAt = quietEndTs(st, chatId);
        const wait = Math.max(0, sendAt - Date.now());

        const timer2 = setTimeout(() => {
            send(chatId, `⏰ ${rec.text}`);
            const currentSt = loadState();
            currentSt.once = currentSt.once.filter(r => String(r.id) !== String(rec.id));
            saveState(currentSt);
        }, Math.min(wait, MAX_TIMEOUT));
        if (timer2.unref) timer2.unref();
    }, Math.min(delay, MAX_TIMEOUT));
    if (timer.unref) timer.unref();
}

function addOnce(send, chatId, atTs, text) {
    const st = loadState();
    const now = Date.now();
    st.once = st.once.filter(r => r.at > now || String(r.id).startsWith('legacy_'));
    if (st.once.length >= 100) st.once = st.once.slice(-50);

    const id = String(Date.now() + Math.random());
    const rec = { id, chatId: String(chatId), at: atTs, text };
    st.once.push(rec);
    saveState(st);
    armOnce(send, chatId, rec);
}

function restoreTimers(send, chatId) {
    const st = loadState();
    st.once
        .filter(r => !r.chatId || String(r.chatId) === String(chatId))
        .forEach(r => armOnce(send, chatId, r));
}

// ИСПРАВЛЕНО: поиск по plantId, а не по имени
function markActionDone(chatId, plantId, action) {
    const st = loadState();
    const entry = st.schedules.find(s =>
        s.action === action &&
        (chatId ? String(s.chatId) === String(chatId) : true) &&
        String(s.plantId) === String(plantId)
    );
    if (!entry) return false;
    entry.lastDone = Date.now();
    entry.nextDue = Date.now() + entry.intervalDays * DAY;
    entry.escalation = 0;
    saveState(st);
    return true;
}

function notifyText(action, plant, level, overdueDays) {
    const A = ACTIONS[action] || ACTIONS.water;
    if (level <= 0) return `${A.emoji} Пора ${A.verb} «${plant}».`;
    if (level === 1) return `${A.emoji} «${plant}» уже сутки ждёт ${A.what}. Давай сегодня — терпение у растений не бесконечное 🙂`;
    const aid = {
        water: 'Полей тёплой отстоянной водой, но понемногу: после долгой засухи залив опаснее засухи.',
        fertilize: 'Подкорми слабым раствором удобрения — навёрстывать двойной дозой нельзя.',
        loosen: 'Аккуратно прорыхли верхний слой — корням нужен воздух.',
        spray: 'Опрыскай листья тёплой водой.'
    }[action];
    return `${A.emoji} Так, «${plant}» без ${A.what} уже ${overdueDays} дней. ${aid}`;
}

function sweepOnce(send, chatId) {
    try {
        const st = loadState();
        const plants = readPlants(chatId);
        const now = Date.now();
        let changed = false;

        for (const p of plants) {
            const name = p.name || p.id;
            const plantId = p.id;
            if (!name || !plantId || !p.schedule) continue;

            for (const action of Object.keys(ACTIONS)) {
                const cfg = p.schedule[action];
                if (!cfg || !cfg.intervalDays || cfg.confirmed === false) continue;

                let entry = st.schedules.find(s =>
                    String(s.chatId) === String(chatId) &&
                    String(s.plantId) === String(plantId) &&
                    s.action === action
                );
                if (!entry) {
                    entry = {
                        chatId: String(chatId),
                        plant: name,
                        plantId: String(plantId), // ИСПРАВЛЕНО: сохраняем plantId
                        action,
                        intervalDays: cfg.intervalDays,
                        nextDue: now + cfg.intervalDays * DAY,
                        escalation: 0, lastNotified: 0, lastDone: 0
                    };
                    st.schedules.push(entry);
                    changed = true;
                }
                if (entry.intervalDays !== cfg.intervalDays) {
                    entry.intervalDays = cfg.intervalDays;
                    changed = true;
                }
                if (entry.lastDone && entry.lastDone + cfg.intervalDays * DAY > entry.nextDue) {
                    entry.nextDue = entry.lastDone + cfg.intervalDays * DAY;
                    entry.escalation = 0;
                    changed = true;
                }
                if (now < entry.nextDue) continue;

                const today = new Date().setHours(0, 0, 0, 0);
                if (entry.lastNotified && new Date(entry.lastNotified).setHours(0, 0, 0, 0) >= today) continue;

                const overdueDays = Math.floor((now - entry.nextDue) / DAY);
                const level = Math.min(Math.max(entry.escalation || 0, overdueDays), 2);
                const wait = isQuiet(st, chatId) ? Math.max(0, quietEndTs(st, chatId) - now) : 0;

                const timer = setTimeout(() => {
                    send(chatId, notifyText(action, name, level, overdueDays));
                    const currentSt = loadState();
                    const currEntry = currentSt.schedules.find(s =>
                        String(s.chatId) === String(chatId) &&
                        String(s.plantId) === String(plantId) &&
                        s.action === action
                    );
                    if (currEntry) {
                        currEntry.lastNotified = Date.now();
                        currEntry.escalation = Math.max(currEntry.escalation || 0, level);
                        saveState(currentSt);
                    }
                }, Math.min(wait, MAX_TIMEOUT));
                if (timer.unref) timer.unref();

                changed = true;
            }
        }
        if (changed) saveState(st);
    } catch (e) {
        console.error('sweepOnce error:', e);
    }
}

function startSweep(send, chatId) {
    const t1 = setTimeout(() => sweepOnce(send, chatId), 10 * 1000);
    const t2 = setInterval(() => sweepOnce(send, chatId), 30 * 60 * 1000);
    if (t1.unref) t1.unref();
    if (t2.unref) t2.unref();
}

module.exports = {
    restoreTimers, startSweep, addOnce, markActionDone,
    setQuiet, getQuiet, parseQuietRange, isQuiet, clearForChat
};