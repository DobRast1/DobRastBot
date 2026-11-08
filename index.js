// ВНИМАНИЕ: отключает проверку TLS глобально. Нужно из-за сертификата НУЦ Минцифры (Сбер).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();

const { Bot } = require('@maxhub/max-bot-api');
const { addRecord, getAvailableDates, getRecordsByDate, deleteRecord, editRecord, loadDiary, saveDiary, checkDangerousAction } = require('./diary.cjs');
const { addPlant, waterPlant, showPlants, generateReport, editPlant, deletePlant, loadPlants, savePlants } = require('./plants.cjs');
const { parseAction, COMMAND_GROUPS, COMMAND_BY_ID } = require('./jarvis.cjs');
const crypto = require('crypto');
const reminders = require('./reminders.cjs');
const passport = require('./passport.cjs');

const MAX_TOKEN = process.env.MAX_TOKEN;
const GIGACHAT_AUTH_KEY = process.env.GIGACHAT_AUTH_KEY;

if (!MAX_TOKEN || !GIGACHAT_AUTH_KEY) {
    console.error('❌ Ошибка: MAX_TOKEN или GIGACHAT_AUTH_KEY не найдены в .env');
    process.exit(1);
}

const bot = new Bot(MAX_TOKEN);

// --- Утилиты ---
function sameUser(a, b) {
    return String(a) === String(b);
}

function getPlantIdByName(chatId, plantName) {
    const plants = loadPlants().filter(p => sameUser(p.userId, chatId));
    const found = plants.find(p => require('./plants.cjs').isSamePlant(p.name, plantName));
    return found ? found.id : null;
}

function timesWord(n) {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return 'раз';
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'раза';
    return 'раз';
}

function minutesWord(n) {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return 'минуту';
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'минуты';
    return 'минут';
}

function cleanReminderText(t) {
    return String(t || '')
        .replace(/^(напомни(?:ть)?|напоминай|пожалуйста)[,\s]+/i, '')
        .trim() || 'напоминание';
}

function tidyAi(text) {
    return String(text || '')
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/`([^`]+)`/g, '$1');
}

// Функция для принудительной постановки названия в именительный падеж
function fixPlantNameCase(name) {
    if (!name) return 'Растение';
    const words = name.trim().split(/\s+/);
    const fixedWords = words.map((word, index) => {
        let n = word.toLowerCase();
        if (n.endsWith('ую') || n.endsWith('юю')) {
            n = n.slice(0, -2) + (n.endsWith('юю') ? 'яя' : 'ая');
        } else if (n.endsWith('ию')) {
            n = n.slice(0, -2) + 'ия';
        } else if (n.endsWith('ю')) {
            n = n.slice(0, -1) + 'я';
        } else if (n.endsWith('у')) {
            n = n.slice(0, -1) + 'а';
        }
        if (index === 0) return n.charAt(0).toUpperCase() + n.slice(1);
        return n;
    });
    return fixedWords.join(' ');
}

// --- GigaChat ---
let cachedToken = null;
let tokenExpiresAt = 0;

async function getGigaChatToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    const response = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "RqUID": crypto.randomUUID(),
            "Authorization": `Basic ${GIGACHAT_AUTH_KEY}`
        },
        body: "scope=GIGACHAT_API_PERS"
    });
    if (!response.ok) throw new Error("Ошибка авторизации GigaChat");
    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiresAt = data.expires_at - 60000;
    return cachedToken;
}

function isBlocked(response) {
    if (!response || !response.choices || !response.choices[0]) return true;
    const reason = response.choices[0].finish_reason;
    const content = (response.choices[0].message && response.choices[0].message.content) || "";
    return reason === 'blacklist' || content.includes("Как и любая языковая модель") || content.includes("К сожалению, иногда") || content.includes("временно ограничены");
}

async function callGigaChat(messages) {
    try {
        const token = await getGigaChatToken();
        const chatResponse = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${token}`, "X-Request-ID": crypto.randomUUID() },
            body: JSON.stringify({ model: "GigaChat", messages: messages })
        });
        if (!chatResponse.ok) return null;
        const chatData = await chatResponse.json();
        if (isBlocked(chatData)) return null;
        return chatData.choices[0].message.content;
    } catch (e) { return null; }
}

async function askGigaChatService(prompt) {
    try {
        const token = await getGigaChatToken();
        const messages = [
            { role: "system", content: "Ты — полезный ассистент. Отвечай строго в формате JSON." },
            { role: "user", content: prompt }
        ];
        const chatResponse = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${token}`, "X-Request-ID": crypto.randomUUID() },
            body: JSON.stringify({ model: "GigaChat", messages: messages })
        });
        if (!chatResponse.ok) return null;
        const chatData = await chatResponse.json();
        if (isBlocked(chatData)) return null;
        return chatData.choices[0].message.content;
    } catch (e) { return null; }
}

// --- ОТПРАВКА (ИСПРАВЛЕНО) ---
async function sendReply(ctx, text, keyboard = null) {
    let safeText = String(text || '').trim();
    if (safeText.length > 3500) safeText = safeText.slice(0, 3400) + '...\n\n[Ответ сокращен]';

    try {
        const options = { format: 'markdown' };
        if (keyboard) options.attachments = [keyboard];
        return await ctx.reply(safeText, options);
    } catch (e) {
        console.error("Ошибка reply с markdown:", e.message);
        try {
            const options = {};
            if (keyboard) options.attachments = [keyboard];
            return await ctx.reply(safeText, options);
        } catch (e2) {
            console.error("Ошибка reply (без markdown):", e2.message);
        }
    }
}

const send = async (chatId, text) => {
    let safeText = String(text || '').trim();
    if (safeText.length > 3500) safeText = safeText.slice(0, 3400) + '...\n\n[Ответ сокращен]';
    try {
        await bot.api.sendMessageToChat(chatId, safeText, { format: 'markdown' });
    } catch (e) {
        try {
            await bot.api.sendMessageToChat(chatId, safeText);
        } catch (e2) { console.error("Ошибка send:", e2.message); }
    }
};

async function editMessage(messageId, newText, newKeyboard = null) {
    if (!messageId) return false;
    try {
        const url = `https://platform-api2.max.ru/messages?message_id=${messageId}`;
        let safeText = String(newText || '').trim();
        if (safeText.length > 3500) safeText = safeText.slice(0, 3400) + '...';
        
        const body = { text: safeText, format: "markdown" };
        if (newKeyboard && newKeyboard.payload && newKeyboard.payload.buttons.length > 0) body.attachments = [newKeyboard];
        
        let response = await fetch(url, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${MAX_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            response = await fetch(url, {
                method: 'PUT',
                headers: { 'Authorization': MAX_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        }
        return response.ok;
    } catch (e) { return false; }
}

// --- КЛАВИАТУРЫ ---
function getMainKeyboard() {
    return {
        type: 'inline_keyboard',
        payload: {
            buttons: [
                [{ type: 'callback', text: '🌿 Растения', payload: 'btn_plants' }, { type: 'callback', text: '📊 Отчет', payload: 'btn_report' }],
                [{ type: 'callback', text: '📈 Статистика', payload: 'btn_stats' }, { type: 'callback', text: '📔 Мой дневник', payload: 'btn_diary' }],
                [{ type: 'callback', text: '📝 Веб-дневник', payload: 'btn_web_diary' }],
                [{ type: 'callback', text: '❓ Помощь', payload: 'btn_help' }]
            ]
        }
    };
}

function getPlantsKeyboard() {
    return {
        type: 'inline_keyboard',
        payload: {
            buttons: [
                [{ type: 'callback', text: '➕ Добавить', payload: 'plant_add' }, { type: 'callback', text: '✏️ Изменить', payload: 'plant_edit_start' }],
                [{ type: 'callback', text: '🗑️ Удалить', payload: 'plant_del_start' }, { type: 'callback', text: '🔙 Назад', payload: 'btn_back' }]
            ]
        }
    };
}

function getBackKeyboard() {
    return {
        type: 'inline_keyboard',
        payload: {
            buttons: [[{ type: 'callback', text: '🔙 Назад', payload: 'btn_back' }]]
        }
    };
}

function getPhotoConfirmKeyboard() {
    return {
        type: 'inline_keyboard',
        payload: {
            buttons: [
                [{ type: 'callback', text: '✅ Да, в дневник', payload: 'photo_save_yes' }],
                [{ type: 'callback', text: '❌ Отмена', payload: 'photo_save_no' }]
            ]
        }
    };
}

const userStates = {};
const lastPlantContext = {};
const chatHistories = {};
const initializedChats = new Set();

function initRemindersFor(chatId) {
    const idStr = String(chatId);
    if (initializedChats.has(idStr)) return;
    initializedChats.add(idStr);
    reminders.restoreTimers(send, chatId);
    reminders.startSweep(send, chatId);
}

const COMMAND_LINES = COMMAND_GROUPS
    .map((g, i) => `**${i + 1}) ${g.group}:**\n` +
        g.items.filter(c => c.command)
            .map(c => `• ${c.command}${c.text ? ` — ${c.text}` : ''}`)
            .join('\n'))
    .join('\n\n');

const SYSTEM_PROMPT = `Ты — ДобРаст, помощник по уходу за растениями.
Отвечай на русском языке.
Характер: уверенный, разговорный, доброжелательный старший брат.
Допустима лёгкая ирония, но без оскорблений, унижения и брани.
Не начинай каждый ответ с обращения или шутки.
Давай конкретные и осторожные рекомендации.
Не выдавай предположительный диагноз растения за установленный факт.
Если данных недостаточно, задай один-два уточняющих вопроса.
Не придумывай дозировки препаратов.
Арифметику не считай в уме: если в сообщении есть числовой пример, система посчитает его сама — просто назови готовый результат дружеским тоном.
Если пользователь просит что-то удалить, но непонятно что — уточни: растение из его списка или запись в дневнике.
Ты можешь использовать markdown: **жирный**, *курсив*. НЕ ИСПОЛЬЗУЙ таблицы, код-блоки и заголовки (#).

Ты — и интерфейс, и собеседник: команды — часть тебя. Если спрашивают, как что-то сделать, объясни по-дружески и назови подходящую команду или способ словами. Различай «как сделать» (подсказать) и «сделай» (выполнить).

Команды:
${COMMAND_LINES}

Без команд ты тоже всё умеешь: «полил лимон», «добавь кактус», «удали розу», «запиши в дневник 5 ноября полил помидор», «напомни полить орхидею через 10 минут», «поливай лимон каждые 3 дня», «не буди меня с 23 до 7». Если просьба понятна — выполняй сразу, не заставляй вводить команду.`;

const TOPICS = [
    { id: "ficus", label: "фикус", re: /фикус/u },
    { id: "orchid", label: "орхидею", re: /орхиде/u },
    { id: "tomato", label: "томаты", re: /томат|помидор/u },
    { id: "seedling", label: "рассаду", re: /рассад/u },
    { id: "rose", label: "розу", re: /(?:^|[^а-я])роз(?:а|ы|у|ой|е|ам|ами|ах)(?=$|[^а-я])/u },
    { id: "plant", label: "растение", re: /растени|цветок|цветы|кактус|монстер|суккулент/u }
];

const REPLIES = {
    stop: [{ id: "stop_1", text: "Понял, останавливаюсь." }, { id: "stop_2", text: "Хорошо, не продолжаю." }],
    privacyOptional: [{ id: "privacy_optional_1", text: "Ладно, без этого обойдёмся." }, { id: "privacy_optional_2", text: "Принято. Этот вопрос снимаю." }],
    privacy: [{ id: "privacy_1", text: "Ладно, не лезу." }, { id: "privacy_2", text: "Принял. Можешь не отвечать." }],
    competence: [{ id: "competence_1", text: "Возможно, промахнулся. Что именно в совете не сходится?" }, { id: "competence_2", text: "Давай перепроверим. Какой момент вызывает сомнения?" }],
    brevity: [{ id: "brevity_1", text: "Принял. Дальше — короче и по делу." }, { id: "brevity_2", text: "Хорошо, без длинных вступлений." }],
    insult: [{ id: "insult_1", text: "Подкол засчитан. Если есть вопрос по растениям — разберём." }, { id: "insult_2", text: "Спорить не буду. С растениями помочь могу." }],
    repeatedHostility: [{ id: "repeat_1", text: "Перепалку продолжать не буду. По растениям — помогу." }, { id: "repeat_2", text: "Давай без перепалки. Если нужна помощь с растением — пиши." }],
    frustration: [{ id: "frustration_1", text: "Похоже, ситуация достала. Что случилось?" }, { id: "frustration_2", text: "Давай разберёмся по порядку. В чём проблема?" }]
};

function normalize(text) {
    return String(text ?? "").normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function detectTopic(text) {
    return TOPICS.find(topic => topic.re.test(text)) ?? null;
}

function classify(text) {
    const topic = detectTopic(text);
    const gardenContext = Boolean(topic) || /полив|поливать|грунт|почв|корн|листь|листок|вредител|удобр|пересад|взрыхл|посад|обрез|подкорм/u.test(text);
    const questionLike = text.includes("?") || /(?:^|\s)(?:как|почему|когда|сколько|зачем|чем)(?:\s|$)/u.test(text) || /что делать|подскажи|помоги/u.test(text);
    const profanity = /(?:^|[^а-я])(?:бля(?:дь|ть)?|сука|еб[а-я]*|ёб[а-я]*|хуй[а-я]*|хуе[а-я]*|пизд[а-я]*|долбо[а-я]*)(?=$|[^а-я])/u.test(text);
    const insult = /(?:^|[^а-я])(?:дурак|идиот|тупой|дебил|бестолочь)(?=$|[^а-я])/u.test(text);

    let act = "normal";
    if (profanity || insult) act = profanity ? "frustration" : "insult";
    else if (/отстань|оставь меня в покое|не пиши мне|иди (?:на|в)\s/u.test(text)) act = "stop";
    else if (/не твое дело/u.test(text) || /(?:тебя|вас)[^.!?\n]{0,50}не\s+(?:касается|должно)/u.test(text)) act = "privacy";
    else if (/ты[^.!?\n]{0,30}ничего не понима/u.test(text) || /ты ошибся|неверный совет|неправильный совет/u.test(text) || /после твоего совета/u.test(text)) act = "competence";
    else if (/без воды|хватит болтать|отвечай короче|говори короче/u.test(text)) act = "brevity";

    return { act, topic, gardenContext, questionLike, rough: profanity || insult };
}

function pickReply(key, state) {
    const all = REPLIES[key];
    const recent = Array.isArray(state.recentReplyIds) ? state.recentReplyIds : [];
    const fresh = all.filter(reply => !recent.includes(reply.id));
    const candidates = fresh.length ? fresh : all;
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    state.recentReplyIds = [...recent, selected.id].slice(-8);
    return selected.text;
}

function localReply(intent, state) {
    if (intent.act === "stop") {
        state.currentExchangeClosed = true;
        state.pendingQuestion = null;
        return pickReply("stop", state);
    }
    if (intent.act === "privacy") {
        const optional = state.lastBotAction === "ask_optional_personal_question";
        state.pendingQuestion = null;
        if (optional) state.optionalPersonalQuestionsDeclined = true;
        return pickReply(optional ? "privacyOptional" : "privacy", state);
    }
    if (intent.gardenContext && intent.questionLike && (intent.rough || intent.act !== "normal")) {
        const topic = intent.topic?.label ?? "растение";
        return `Разберём ${topic}. Опиши отдельно симптомы, полив и освещение.`;
    }
    if (intent.act === "competence") return pickReply("competence", state);
    if (intent.act === "brevity") { state.answerStyle = "brief"; return pickReply("brevity", state); }
    if (intent.act === "insult" || intent.act === "frustration") {
        state.hostileTurns = (state.hostileTurns ?? 0) + 1;
        if (state.hostileTurns >= 2) return pickReply("repeatedHostility", state);
        return pickReply(intent.act, state);
    }
    return null;
}

function getHistory(chatId) {
    const idStr = String(chatId);
    if (!chatHistories[idStr]) {
        chatHistories[idStr] = [{ role: "system", content: SYSTEM_PROMPT }];
    }
    return chatHistories[idStr];
}

function trimHistory(history) {
    const MAX_MESSAGES = 9;
    if (history.length <= MAX_MESSAGES) return history;
    const excess = history.length - MAX_MESSAGES;
    const safeCut = excess % 2 === 0 ? excess : excess + 1;
    history.splice(1, safeCut);
    return history;
}

async function withDeadline(operation, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("REQUEST_TIMEOUT")); }, timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]); }
    finally { clearTimeout(timer); }
}

function fallback(intent, reason) {
    if (reason === "blacklist") {
        return intent.gardenContext ? "Не получилось ответить на этот запрос. Укажи растение и его симптомы отдельно." : "Не получилось ответить на этот запрос. Если вопрос о растениях — укажи растение и проблему.";
    }
    return "Сейчас не удалось получить ответ. Попробуй ещё раз чуть позже.";
}

function scheduleActionFromNote(action) {
    const a = String(action || '').toLowerCase();
    if (/подкорм|удобр/.test(a)) return 'fertilize';
    if (/рыхл/.test(a)) return 'loosen';
    if (/опрыск/.test(a)) return 'spray';
    if (/полив/.test(a)) return 'water';
    return null;
}

async function askGigaChat(chatId, text, options = {}) {
    const { state = {}, model = "GigaChat", timeoutMs = 15000 } = options;
    if (typeof text !== "string" || !text.trim()) return "Напиши вопрос или расскажи, что случилось с растением.";
    if (text.length > 8000) return "Сообщение слишком длинное. Пришли отдельно растение, симптомы и условия ухода.";

    const history = getHistory(chatId);
    const normalized = normalize(text);
    const intent = classify(normalized);
    const local = localReply(intent, state);
    if (local) { state.lastBotAction = "local_reply"; return local; }

    state.hostileTurns = 0;
    state.currentExchangeClosed = false;
    if (intent.topic) state.lastTopic = intent.topic.id;

    const systemPrompt = [SYSTEM_PROMPT, state.answerStyle === "brief" ? "Пользователь предпочитает короткие ответы." : ""].filter(Boolean).join("\n\n");
    history[0] = { role: "system", content: systemPrompt };

    history.push({ role: "user", content: text.trim() });
    trimHistory(history);

    try {
        const result = await withDeadline(async signal => {
            const accessToken = await getGigaChatToken();
            if (typeof accessToken !== "string" || !accessToken) throw new Error("TOKEN_UNAVAILABLE");
            signal.throwIfAborted();

            const response = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({
                    model,
                    messages: history,
                    temperature: 0.6,
                    max_tokens: state.answerStyle === "brief" ? 250 : 600
                }),
                signal
            });

            if (!response.ok) return { kind: "http_error", status: response.status };
            const data = await response.json();
            const choice = data?.choices?.[0];
            const reason = String(choice?.finish_reason ?? "").toLowerCase();
            if (reason === "blacklist") return { kind: "blacklist" };
            const answer = choice?.message?.content;
            if (reason !== "stop" || typeof answer !== "string" || !answer.trim()) return { kind: "invalid_result", finishReason: reason };
            return { kind: "success", answer: answer.trim() };
        }, timeoutMs);

        if (result.kind === "success") {
            state.lastBotAction = "give_advice";
            history.push({ role: "assistant", content: result.answer });
            return tidyAi(result.answer);
        }
        history.pop();
        return fallback(intent, result.kind);
    } catch {
        if (history.length > 0 && history[history.length - 1].role === "user") history.pop();
        return fallback(intent, "request_failed");
    }
}

const getHelpText = () => {
    return `📋 **Справка по ДобРасту**

**1. Кнопки меню:**
🌿 Растения — добавить, изменить или удалить.
📊 Отчет — готовый бланк для проекта.
📈 Статистика — сколько у тебя растений и записей.
📔 Мой дневник — календарь записей.
📝 Веб-дневник — ссылка на красивый дневник.

**2. Все текстовые команды:**

${COMMAND_LINES}

**3. Как записывать в дневник:**
• Ты можешь просто рассказать мне, что сделал с растением. Например: «Я полил ...» или «Обрезал сухие ветки у ...». Я сохраню это в дневник.
• Если нужно записать на другую дату, напиши: «Запиши в дневник 5 ноября полил ...».
• Или просто отправь фото растения.

**4. Паспорт и расписание:**
• После добавления нового растения я сам предложу заполнить паспорт (место, окно, грунт, горшок) и составлю график полива, подкормки, рыхления и опрыскивания.
• Посмотреть паспорт: /plant passport (растение).
• Поменять график словами: «поливай лимон каждые 3 дня».
• Настроить тишину словами: «не буди меня с 23 до 7».
• Если полил раньше срока — график пересчитается сам, а напоминание отменится.`;
};

const KNOWN_COMMANDS = ['/start', '/help', '/plants', '/plant', '/silence', '/тишина', '/top', '/report', '/stats', '/notes', '/calendar', '/reset', '/mdtest'];

function buildGithubDiaryUrl(chatId) {
    const diary = loadDiary().filter(r => sameUser(r.userId, chatId));
    const baseUrl = 'https://dobrast1.github.io/DobRastBot/';
    if (diary.length === 0) return baseUrl;
    const encodedData = encodeURIComponent(JSON.stringify(diary));
    return `${baseUrl}?data=${encodedData}`;
}

bot.on('bot_started', async (ctx) => {
    console.log("🟢 Событие bot_started. Отправляем справку...");
    if (typeof ctx.reply === 'function') {
        try {
            await ctx.reply(getHelpText(), { format: 'markdown', attachments: [getMainKeyboard()] });
            console.log("✅ Справка отправлена через ctx.reply");
            return;
        } catch (e) {}
    }
});

bot.command('start', (ctx) => {
    const chatId = ctx.message.recipient.chat_id;
    initRemindersFor(chatId);
    return sendReply(ctx, getHelpText(), getMainKeyboard());
});

bot.command('help', (ctx) => {
    return sendReply(ctx, getHelpText(), getMainKeyboard());
});

bot.command('mdtest', (ctx) => {
    return sendReply(ctx, "**Жирный** и *курсив*");
});

bot.command('notes', (ctx) => {
    const chatId = ctx.message.recipient.chat_id;
    const datesText = getAvailableDates(chatId);
    const dates = [...new Set(loadDiary().filter(r => sameUser(r.userId, chatId)).map(r => r.date))].sort().reverse();
    const buttons = [];
    dates.forEach(d => {
        const formatted = new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
        buttons.push([{ type: 'callback', text: `📅 ${formatted}`, payload: `date_${d}` }]);
    });

    if (buttons.length === 0) {
        sendReply(ctx, "Дневник пока пуст.", getBackKeyboard());
    } else {
        buttons.push([{ type: 'callback', text: '🔙 Назад', payload: 'btn_back' }]);
        sendReply(ctx, datesText, { type: 'inline_keyboard', payload: { buttons } });
    }
});

bot.command('calendar', (ctx) => {
    const chatId = ctx.message.recipient.chat_id;
    const webUrl = buildGithubDiaryUrl(chatId);
    const keyboard = {
        type: 'inline_keyboard',
        payload: {
            buttons: [
                [{ type: 'link', text: '🌐 Открыть веб-дневник', url: webUrl }],
                [{ type: 'callback', text: '🔙 Назад', payload: 'btn_back' }]
            ]
        }
    };
    return sendReply(ctx, `Твой веб-дневник готов! Нажми на кнопку ниже.`, keyboard);
});

bot.command('report', (ctx) => sendReply(ctx, generateReport(ctx.message.recipient.chat_id), getBackKeyboard()));
bot.command('plants', (ctx) => sendReply(ctx, showPlants(ctx.message.recipient.chat_id), getPlantsKeyboard()));

bot.command('stats', (ctx) => {
    const chatId = ctx.message.recipient.chat_id;
    const plants = loadPlants().filter(p => sameUser(p.userId, chatId));
    const diary = loadDiary().filter(r => sameUser(r.userId, chatId));
    sendReply(ctx, `📈 **Статистика:**\n🌿 Растений: **${plants.length}**\n📝 Записей: **${diary.length}**`, getBackKeyboard());
});

bot.command('top', (ctx) => {
    const chatId = ctx.message.recipient.chat_id;
    const plants = loadPlants().filter(p => sameUser(p.userId, chatId));
    if (plants.length === 0) return sendReply(ctx, "У тебя пока нет растений.");
    let oldest = plants[0];
    plants.forEach(p => { if (new Date(p.lastWatered) < new Date(oldest.lastWatered)) oldest = p; });
    const daysAgo = Math.floor((new Date() - new Date(oldest.lastWatered)) / (1000 * 60 * 60 * 24));
    sendReply(ctx, `🏆 Самое забытое — **${oldest.name}**. Не поливал ${daysAgo} дн. 💧`, getBackKeyboard());
});

bot.command('reset', (ctx) => {
    const chatId = ctx.message.recipient.chat_id;
    const idStr = String(chatId);
    chatHistories[idStr] = [{ role: "system", content: SYSTEM_PROMPT }];
    delete userStates[chatId];
    delete userStates[idStr];
    delete lastPlantContext[chatId];
    delete lastPlantContext[idStr];
    try { reminders.clearForChat(chatId); } catch (e) { console.error(e); }
    try { passport.clearSession(chatId); } catch (e) { console.error(e); }
    sendReply(ctx, "Память очищена! Забыл всё, включая расписание. 🧹✨");
});

bot.on('message_callback', async (ctx) => {
    if (ctx.answer) await ctx.answer().catch(() => {});
    const payload = ctx.callback.payload;
    const chatId = ctx.message.recipient.chat_id;
    const messageId = ctx.message.body.mid;

    const safeReply = async (text, keyboard = null) => {
        const success = await editMessage(messageId, text, keyboard);
        if (!success) {
            sendReply(ctx, text, keyboard);
        }
    };

    if (payload === 'btn_diary') {
        const datesText = getAvailableDates(chatId);
        const dates = [...new Set(loadDiary().filter(r => sameUser(r.userId, chatId)).map(r => r.date))].sort().reverse();
        const buttons = [];
        dates.forEach(d => {
            const formatted = new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
            buttons.push([{ type: 'callback', text: `📅 ${formatted}`, payload: `date_${d}` }]);
        });

        if (buttons.length === 0) {
            safeReply("Дневник пока пуст.", getBackKeyboard());
        } else {
            buttons.push([{ type: 'callback', text: '🔙 Назад', payload: 'btn_back' }]);
            safeReply(datesText, { type: 'inline_keyboard', payload: { buttons } });
        }
    }
    else if (payload.startsWith('date_')) {
        const dateStr = payload.replace('date_', '');
        const recordsText = getRecordsByDate(chatId, dateStr);
        const buttons = [
            [{ type: 'callback', text: '✏️ Редактировать', payload: `edit_${dateStr}` }, { type: 'callback', text: '🗑️ Удалить', payload: `del_${dateStr}` }],
            [{ type: 'callback', text: '🔙 Назад к датам', payload: 'btn_diary' }]
        ];
        safeReply(recordsText, { type: 'inline_keyboard', payload: { buttons } });
    }
    else if (payload.startsWith('edit_')) {
        const dateStr = payload.replace('edit_', '');
        userStates[chatId] = { action: 'awaiting_diary_edit', dateStr: dateStr };
        await sendReply(ctx, `Введи номер записи и новый текст через запятую (для даты ${dateStr}).\nНапример: **1, Листья пожелтели**`);
    }
    else if (payload.startsWith('del_')) {
        const dateStr = payload.replace('del_', '');
        userStates[chatId] = { action: 'awaiting_diary_delete', dateStr: dateStr };
        await sendReply(ctx, `Введи номер записи, которую хочешь удалить (для даты ${dateStr}).`);
    }
    else if (payload === 'btn_plants') {
        safeReply(showPlants(chatId), getPlantsKeyboard());
    }
    else if (payload === 'btn_back' || payload === 'btn_help') {
        safeReply(getHelpText(), getMainKeyboard());
    }
    else if (payload === 'plant_add') {
        userStates[chatId] = { action: 'awaiting_add' };
        await sendReply(ctx, "Напиши название растения и где оно стоит (через запятую).\nНапример: **Лимон, дома**");
    }
    else if (payload === 'plant_edit_start') {
        userStates[chatId] = { action: 'awaiting_edit' };
        await sendReply(ctx, "Напиши, какое растение изменить и на что.\nНапример: **Лимон, Лайм, дома**");
    }
    else if (payload === 'plant_del_start') {
        userStates[chatId] = { action: 'awaiting_delete' };
        await sendReply(ctx, "Напиши название растения, которое хочешь удалить.");
    }
    else if (payload === 'btn_report') {
        safeReply(generateReport(chatId), getBackKeyboard());
    }
    else if (payload === 'btn_stats') {
        const plants = loadPlants().filter(p => sameUser(p.userId, chatId));
        const diary = loadDiary().filter(r => sameUser(r.userId, chatId));
        safeReply(`📈 **Твоя статистика:**\n\n🌿 Растений: **${plants.length}**\n📝 Записей: **${diary.length}**`, getBackKeyboard());
    }
    else if (payload === 'btn_web_diary') {
        const webUrl = buildGithubDiaryUrl(chatId);
        const keyboard = {
            type: 'inline_keyboard',
            payload: {
                buttons: [
                    [{ type: 'link', text: '🌐 Открыть веб-дневник', url: webUrl }],
                    [{ type: 'callback', text: '🔙 Назад', payload: 'btn_back' }]
                ]
            }
        };
        safeReply(`Твой веб-дневник готов! Нажми на кнопку ниже.`, keyboard);
    }
    else if (payload === 'photo_save_yes') {
        const today = new Date().toISOString().split('T')[0];
        addRecord(chatId, "Фото растения (сохранено в дневник)", today);
        safeReply("📸 Отлично! Фото сохранено в дневник на сегодня.\n\nТеперь опиши словами, что тебя беспокоит (например: «листья желтеют»), и я поставлю диагноз.");
    }
    else if (payload === 'photo_save_no') {
        safeReply("Окей, не буду сохранять фото. Если что, просто напиши вопрос словами.");
    }
});

bot.on('message_created', async (ctx) => {
    try {
        if (!ctx.message || !ctx.message.body) return;

        const chatId = ctx.message.recipient.chat_id;
        const text = ctx.message.body.text;

        if (ctx.message.body.attachments && ctx.message.body.attachments.length > 0) {
            const attachment = ctx.message.body.attachments[0];
            if (attachment.type === 'image') {
                return sendReply(ctx, "📸 Я вижу фото растения! Хочешь сохранить его в дневник наблюдений?", getPhotoConfirmKeyboard());
            }
        }

        if (!text) return;
        const lower = text.toLowerCase().trim();

        initRemindersFor(chatId);

        if (text.startsWith('/')) {
            const argsStr = text.replace(/^\/[a-zA-Zа-яА-ЯёЁ]+\s*/, '').trim();
            const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');

            if (cmd === '/plant') {
                if (!argsStr) return sendReply(ctx, 'Как пользоваться:\n/plant passport лимон — паспорт растения\n/plant graph — графики ухода всех растений');
                const parts = argsStr.split(/\s+/);
                const sub = parts[0].toLowerCase();
                const name = parts.slice(1).join(' ').trim();

                if (sub === 'passport') {
                    if (!name) return sendReply(ctx, 'Укажи растение. Пример: /plant passport лимон');
                    passport.showPassport(name, send, chatId);
                    return;
                }
                if (sub === 'graph') {
                    const plants = loadPlants().filter(p => sameUser(p.userId, chatId));
                    if (plants.length === 0) return sendReply(ctx, 'Растений пока нет. Добавь через /plants — и я составлю график.');
                    const LABELS = { water: 'Полив', fertilize: 'Подкормка', loosen: 'Рыхление', spray: 'Опрыскивание' };
                    let out = '📅 **Графики ухода**\n\n';
                    for (const p of plants) {
                        out += `🌿 **${p.name}**\n`;
                        if (p.schedule && Object.keys(p.schedule).length) {
                            for (const [k, l] of Object.entries(LABELS)) {
                                if (p.schedule[k]) out += `   • ${l}: каждые ${p.schedule[k].intervalDays} дн.\n`;
                            }
                        } else {
                            out += '   график ещё не составлен\n';
                        }
                        out += '\n';
                    }
                    return sendReply(ctx, out);
                }
                return sendReply(ctx, 'Не понял. Доступно:\n/plant passport лимон\n/plant graph');
            }

            if (cmd === '/silence' || cmd === '/тишина') {
                if (!argsStr) {
                    const q = reminders.getQuiet(chatId);
                    if (q && q.from) {
                        return sendReply(ctx, `Сейчас я не пишу напоминания с ${q.from} до ${q.to}. Задать своё окно: /silence 22:00-08:00`);
                    }
                    return sendReply(ctx, 'Напоминания приходят всегда, но ночью (с 22:00 до 08:00) я молчу по умолчанию.\nЗадать своё окно: `/silence ЧЧ:ММ-ЧЧ:ММ` — например, `/silence 23:00-07:00`');
                }
                const range = reminders.parseQuietRange(argsStr);
                if (!range) return sendReply(ctx, 'Не понял формат. Пример: /silence 22:00-08:00');
                reminders.setQuiet(chatId, range.from, range.to);
                return sendReply(ctx, `Запомнил: с ${range.from} до ${range.to} — спим. Всё, что должно сработать ночью, догонит утром 🙂`);
            }

            if (KNOWN_COMMANDS.includes(cmd)) {
                if (argsStr) {
                    return sendReply(ctx, `Команда \`${cmd}\` не принимает аргументов. Просто отправь \`${cmd}\`.`);
                }
                return;
            }

            return sendReply(ctx, 'Такой команды не знаю 🙂 Вся справка — /help, а можно просто написать словами, что нужно.');
        }

        if (passport.hasSession(chatId)) {
            if (await passport.handleInput(chatId, text, send)) return;
        }

        const pm = text.match(/^паспорт\s+(.+)$/i);
        if (pm) {
            passport.showPassport(pm[1].trim(), send, chatId);
            return;
        }

        const state = userStates[chatId];
        if (state) {
            if (state.action === 'awaiting_diary_edit') {
                const parts = text.split(',');
                if (parts.length < 2) return sendReply(ctx, "Ошибка. Напиши: Номер, Новый текст.");
                const index = parseInt(parts[0].trim(), 10);
                const newText = parts.slice(1).join(',').trim();
                const dateStr = state.dateStr;
                delete userStates[chatId];
                return sendReply(ctx, editRecord(chatId, dateStr, index, newText), getBackKeyboard());
            }
            if (state.action === 'awaiting_diary_delete') {
                const index = parseInt(text.trim(), 10);
                const dateStr = state.dateStr;
                if (isNaN(index)) return sendReply(ctx, "Ошибка. Напиши номер записи.");
                delete userStates[chatId];
                return sendReply(ctx, deleteRecord(chatId, dateStr, index), getBackKeyboard());
            }
            if (state.action === 'awaiting_diary_confirm') {
                if (lower === 'да' || lower === 'yes') {
                    const { dateStr, notePart } = state;
                    delete userStates[chatId];
                    const result = addRecord(chatId, notePart, dateStr);
                    return sendReply(ctx, result, getBackKeyboard());
                }
                delete userStates[chatId];
                return sendReply(ctx, "Окей, отменил запись.");
            }
            if (state.action === 'awaiting_clear_confirm') {
                if (lower === 'да' || lower === 'yes') {
                    delete userStates[chatId];
                    if (state.what === 'plants') {
                        savePlants(loadPlants().filter(p => !sameUser(p.userId, chatId)));
                        lastPlantContext[chatId] = null;
                        return sendReply(ctx, "Усё. Растений больше нет. Начинаем с чистого грядка.", getBackKeyboard());
                    }
                    saveDiary(loadDiary().filter(r => !sameUser(r.userId, chatId)));
                    return sendReply(ctx, "Дневник стёрт. Никто не докажет, что ты забывал поливать.", getBackKeyboard());
                }
                delete userStates[chatId];
                return sendReply(ctx, "Отменил. Ничего не тронуто.");
            }
            if (state.action === 'awaiting_add') {
                const parts = text.split(',');
                let plantName = (parts[0] || '').trim();
                if (!plantName || plantName === ',' || plantName.length < 2) {
                    return sendReply(ctx, "Ошибка. Напиши название растения (например: Лимон, дома).");
                }
                
                plantName = fixPlantNameCase(plantName);

                const loc = parts[1] ? parts[1].trim() : null;
                delete userStates[chatId];
                const result = addPlant(chatId, plantName, loc || '', new Date().toISOString());
                
                passport.startPassport(send, chatId, askGigaChatService, plantName, loc);
                return;
            }
            if (state.action === 'awaiting_edit') {
                const parts = text.split(',');
                if (parts.length < 2) return sendReply(ctx, "Ошибка. Напиши: Старое, Новое.");
                delete userStates[chatId];
                return sendReply(ctx, editPlant(chatId, parts[0].trim(), parts[1].trim(), parts[2] ? parts[2].trim() : null), getPlantsKeyboard());
            }
            if (state.action === 'awaiting_delete') {
                delete userStates[chatId];
                return sendReply(ctx, deletePlant(chatId, text.trim()), getPlantsKeyboard());
            }
        }

        if (lower.includes("напомни")) {
            const localM = text.match(/через\s+(\d+)\s*(мин|минут\S*)/i);
            if (localM) {
                const minutes = parseInt(localM[1], 10);
                if (minutes > 0) {
                    let reminderText = text.replace(/напомни\b/i, '').replace(/через\s+\d+\s*\S*\s*(минут\S*)?/i, '').trim();
                    if (!reminderText) reminderText = "напоминание";
                    reminders.addOnce(send, chatId, Date.now() + minutes * 60000, reminderText);
                    return sendReply(ctx, `Окей! Напомню про "${reminderText}" через ${minutes} ${minutesWord(minutes)}! 🔔`);
                }
            }
            const promptForReminder = `Выдели из текста: 1) через сколько минут напомнить (только число), 2) что именно напомнить (кратко). Ответь строго в формате JSON: {"minutes": 5, "text": "полить лимон"}. Текст: "${text}"`;
            const aiResponse = await askGigaChatService(promptForReminder);

            if (aiResponse) {
                try {
                    const jsonMatch = aiResponse.match(/\{.*\}/s);
                    if (jsonMatch) {
                        const data = JSON.parse(jsonMatch[0]);
                        const minutes = Number(data.minutes);
                        const reminderText = cleanReminderText(data.text);

                        if (!isNaN(minutes) && minutes > 0 && reminderText) {
                            reminders.addOnce(send, chatId, Date.now() + minutes * 60000, reminderText);
                            return sendReply(ctx, `Окей! Напомню про "${reminderText}" через ${minutes} ${minutesWord(minutes)}! 🔔`);
                        }
                    }
                } catch (e) {}
            }
            return sendReply(ctx, "Напиши так: 'напомни полить лимон через 1 минуту'");
        }

        const hasRussian = /[а-яё]/i.test(text);
        const hasEnglish = /[a-z]/i.test(text);
        let textForAi = text;

        if (hasEnglish && !hasRussian && text.length > 3 && !text.includes(' ')) {
            const enToRu = {
                'q':'й','w':'ц','e':'у','r':'к','t':'е','y':'н','u':'г','i':'ш','o':'щ','p':'з','[':'х',']':'ъ',
                'a':'ф','s':'ы','d':'в','f':'а','g':'п','h':'р','j':'о','k':'л','l':'д',';':'ж','\'':'э',
                'z':'я','x':'ч','c':'с','v':'м','b':'и','n':'т','m':'ь',',':'б','.':'ю'
            };
            textForAi = text.toLowerCase().split('').map(char => enToRu[char] || char).join('');
        }

        const parsed = await parseAction(callGigaChat, textForAi, lastPlantContext[chatId] || null);

        if (parsed) {
            const today = new Date().toISOString().split('T')[0];

            switch (parsed.type) {
                case 'water': {
                    const plantName = parsed.plant;
                    lastPlantContext[chatId] = plantName;

                    const diary = loadDiary();
                    const todayWaterings = diary.filter(r =>
                        sameUser(r.userId, chatId) &&
                        r.date === today &&
                        (r.plant || '').toLowerCase() === plantName.toLowerCase() &&
                        r.note === 'Полив'
                    ).length;

                    const waterResult = waterPlant(chatId, plantName);
                    addRecord(chatId, "Полив", today, plantName);
                    
                    const pid = getPlantIdByName(chatId, plantName);
                    if (pid) reminders.markActionDone(chatId, pid, 'water');

                    if (todayWaterings >= 2) {
                        return sendReply(ctx, `Стоп, столько не надо. ${plantName.charAt(0).toUpperCase() + plantName.slice(1)} ты поливаешь уже ${todayWaterings + 1} ${timesWord(todayWaterings + 1)} за сегодня — это перелив, корни могут загнить. Запись я добавил, но слей воду из поддона и дай земле просохнуть.`);
                    }
                    if (todayWaterings === 1) {
                        return sendReply(ctx, `Хм, ты уже поливал ${plantName} сегодня. Записал, но чаще раза в день поливать не стоит — проверь, точно ли земля сухая.`);
                    }
                    if (/не нашел|не нашёл/i.test(waterResult)) {
                        return sendReply(ctx, `Записал в дневник: Полив. Но в списке растений такого нет — добавь его, чтобы я отслеживал поливы по расписанию.`);
                    }
                    return sendReply(ctx, waterResult);
                }
                case 'plant_add': {
                    lastPlantContext[chatId] = parsed.plant;
                    
                    const fixedPlantName = fixPlantNameCase(parsed.plant);

                    const addResult = addPlant(chatId, fixedPlantName, (parsed.location || 'дома').toLowerCase(), new Date().toISOString());
                    
                    passport.startPassport(send, chatId, askGigaChatService, fixedPlantName, parsed.location || null);
                    
                    return;
                }
                case 'plant_delete': {
                    lastPlantContext[chatId] = parsed.plant;
                    return sendReply(ctx, deletePlant(chatId, parsed.plant), getPlantsKeyboard());
                }
                case 'plant_clear': {
                    userStates[chatId] = { action: 'awaiting_clear_confirm', what: 'plants' };
                    return sendReply(ctx, "Стоп. Ты хочешь удалить **ВСЕ растения** без возврата. Уверен? Напиши **Да** или **Нет**.");
                }
                case 'diary_clear': {
                    userStates[chatId] = { action: 'awaiting_clear_confirm', what: 'diary' };
                    return sendReply(ctx, "Так, аккуратно: ты хочешь стереть **весь дневник**? Все записи пропадут навсегда. Напиши **Да** или **Нет**.");
                }
                case 'diary': {
                    const eventDate = parsed.date || today;
                    if (parsed.plant) lastPlantContext[chatId] = parsed.plant;
                    const warning = checkDangerousAction(chatId, parsed.action, eventDate, parsed.plant);
                    const result = addRecord(chatId, parsed.action, eventDate, parsed.plant);
                    const schedAction = scheduleActionFromNote(parsed.action);
                    if (schedAction && parsed.plant) {
                        const pid = getPlantIdByName(chatId, parsed.plant);
                        if (pid) reminders.markActionDone(chatId, pid, schedAction);
                    }
                    return sendReply(ctx, warning ? `${result}\n\n⚠️ ${warning}` : result, getBackKeyboard());
                }
                case 'query_plants': {
                    return sendReply(ctx, showPlants(chatId), getPlantsKeyboard());
                }
                case 'query_diary': {
                    const dates = [...new Set(loadDiary().filter(r => sameUser(r.userId, chatId)).map(r => r.date))].sort().reverse();
                    if (dates.length === 0) {
                        return sendReply(ctx, "Дневник пока пуст. Расскажи, что сделал с растениями — запишу.");
                    }
                    const buttons = dates.map(d => {
                        const formatted = new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
                        return [{ type: 'callback', text: `📅 ${formatted}`, payload: `date_${d}` }];
                    });
                    return sendReply(ctx, getAvailableDates(chatId), { type: 'inline_keyboard', payload: { buttons } });
                }
                case 'interval': {
                    if (passport.setIntervalDirect(parsed.plant, parsed.action, parsed.days, chatId)) {
                        return sendReply(ctx, `Записал: ${parsed.plant} — каждые ${parsed.days} дн. 🌿 График обновлён, срок пересчитан от сегодня.`);
                    }
                    return sendReply(ctx, `«${parsed.plant}» не нашёл в списке. Добавь растение через /plants, потом зададим график.`);
                }
                case 'quiet': {
                    reminders.setQuiet(chatId, parsed.from, parsed.to);
                    return sendReply(ctx, `Принял: с ${parsed.from} до ${parsed.to} не будим. Всё важное догоню утром 🙂`);
                }
                case 'help': {
                    const cap = parsed.action ? COMMAND_BY_ID[parsed.action] : null;
                    return sendReply(ctx, 
                        cap ? cap.helpText
                            : 'Вся справка по мне: /help. А можешь просто спросить словами, что хочешь сделать 🙂'
                    );
                }
            }
        }

        const idStr = String(chatId);
        if (!chatHistories[idStr]) {
            chatHistories[idStr] = [{ role: "system", content: SYSTEM_PROMPT }];
        }
        if (!chatHistories[idStr]._brainState) {
            chatHistories[idStr]._brainState = {};
        }
        const brainState = chatHistories[idStr]._brainState;

        const answer = await askGigaChat(chatId, textForAi, { state: brainState });
        await sendReply(ctx, answer);

    } catch (error) {
        console.error("Критическая ошибка:", error);
        // ИСПРАВЛЕНИЕ: безопасный вызов без markdown, чтобы сообщение точно ушло
        sendReply(ctx, "Упс, что-то пошло не так. Попробуй еще раз.", null).catch(() => {});
    }
});

process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

bot.start();
console.log("ДобРаст (MAX) запущен! Паспорт растений, расписание, часы тишины и эскалация на месте. 🌿");