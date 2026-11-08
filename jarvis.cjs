// «Джарвис»: превращает свободный текст пользователя в структурированное действие.

const COMMAND_GROUPS = [
    { group: 'Растения', items: [
        { id: 'plants.list',   command: '/plants',                    text: 'показать все растения', helpText: 'Все растения в одном списке: /plants. Или просто скажи «покажи растения» — покажу и так.' },
        { id: 'plant.add',     command: null,                         text: null, helpText: 'Новое растение добавляется словами: «добавь лимон» или «у меня появился фикус». Дальше я сам предложу заполнить паспорт.' },
        { id: 'passport.open', command: '/plant passport (растение)', text: 'паспорт растения', helpText: 'Паспорт — это место, освещение, грунт и график ухода. Открывается так: /plant passport лимон — подставь своё растение. Или скажи «паспорт лимона».' },
        { id: 'schedule.view', command: '/plant graph',               text: 'графики ухода для всех растений', helpText: 'Обзор всех графиков сразу: /plant graph. А меняю я график и просто словами: «поливай лимон каждые 3 дня».' },
        { id: 'plants.top',    command: '/top',                       text: 'самое забытое растение', helpText: 'Кто дольше всех без воды — покажет /top.' },
        { id: 'quiet.set',     command: '/silence ЧЧ:ММ-ЧЧ:ММ',       text: 'часы, когда я не напоминаю', helpText: 'Часы тишины задаются командой /silence 22:00-08:00 или словами: «не буди меня с 23 до 7».' },
        { id: 'plant.delete',  command: null,                         text: null, helpText: 'Удалять растения проще всего словами: «удали лимон» — если сомневаюсь, кого именно, уточню.' }
    ]},
    { group: 'Отчёты', items: [
        { id: 'report.build', command: '/report', text: 'сгенерировать отчет', helpText: 'Готовый бланк для проекта: /report.' },
        { id: 'stats.show',   command: '/stats',  text: 'статистика', helpText: 'Сколько у тебя растений и записей: /stats.' }
    ]},
    { group: 'Дневник', items: [
        { id: 'diary.view', command: '/notes',    text: 'твой текстовый дневник', helpText: 'Дневник по датам: /notes. Записывать в него можно просто словами — расскажи, что сделал с растением.' },
        { id: 'diary.add',  command: null,        text: null, helpText: 'Запись в дневник — просто расскажи: «полил лимон», «обрезал фикус», «запиши в дневник 5 ноября полил помидор». Или отправь фото.' },
        { id: 'web.open',   command: '/calendar', text: 'ссылка на веб-дневник', helpText: 'Красивый веб-дневник: /calendar.' }
    ]},
    { group: 'Служебное', items: [
        { id: 'brain.reset',   command: '/reset', text: 'очистить память ДобРаста', helpText: 'Забыть наш разговор: /reset.' },
        { id: 'reminders.set', command: null,     text: null, helpText: 'Разовое напоминание: «напомни полить лимон через 10 минут».' },
        { id: 'help.show',     command: '/help',  text: 'показать эту справку', helpText: 'Вся справка — /help. Но можешь и просто спросить словами, что хочешь сделать — подскажу 🙂' }
    ]}
];

const COMMAND_BY_ID = {};
COMMAND_GROUPS.forEach(g => g.items.forEach(c => { COMMAND_BY_ID[c.id] = c; }));
const HELP_IDS = Object.keys(COMMAND_BY_ID);

const VALID_TYPES = [
    'water', 'plant_add', 'plant_delete', 'plant_clear',
    'diary_clear', 'diary', 'query_plants', 'query_diary', 'question',
    'interval', 'quiet', 'help'
];

const JARVIS_SYSTEM_PROMPT = `Ты — классификатор действий садовода. Пользователь пишет сообщение о своих растениях или дневнике. Верни СТРОГО один JSON-объект: без пояснений, без markdown, без обратных кавычек, без текста до или после JSON.

Схема:
{"type": "...", "action": "строка или null", "plant": "строка или null", "location": "строка или null", "date": "YYYY-MM-DD или null", "days": "число или null", "from": "HH:MM или null", "to": "HH:MM или null"}

ДОСТУПНЫЕ ТИПЫ (выбирай ровно один):

1. type = "water" — пользователь ПОЛИЛ растение (полил, поливаю, поливка). Даже если в тексте есть дата в прошлом — type всё равно "water". action = "Полив". ВАЖНО: type = "water" ТОЛЬКО если растение явно названо в сообщении («полил лимон») или заменено местоимением при наличии блока [ПОСЛЕДНЕЕ РАСТЕНИЕ] («полил его»). Если растение не названо и блока нет («полил», «полил вчера всё») — type = "question".
2. type = "plant_add" — появилось НОВОЕ растение: посадил, купил, подарили, взял, посеял, прорастил, а также обороты «у меня есть X», «у меня растёт X», «теперь у меня есть X» — это тоже plant_add.
3. type = "plant_delete" — удаляется ОДНО конкретное растение: "удали фикус", "удали его", "выбросил кактус", "он умер".
4. type = "plant_clear" — удаляются ВСЕ растения: "удали все растения", "очисти список растений", "сотри все мои цветы". ТОЛЬКО если явно сказано «все» и речь про растения.
5. type = "diary_clear" — удаляются ВСЕ ЗАМЕТКИ или ВЕСЬ дневник: "удали все мои заметки", "очисти дневник", "сотри все записи". ТОЛЬКО если явно речь про заметки/дневник/записи. ВАЖНО: «заметки» и «растения» — это РАЗНЫЕ вещи. Заметки — записи в дневнике. Растения — список цветов в боте. Никогда не путай их.
6. type = "diary" — ЛЮБОЕ действие с растением, которое нужно ЗАПИСАТЬ в дневник, ничего не меняя в списке: обрезал, привил, опрыскал, подкормил, удобрил, пересадил, пикировал, распикировал, проредил, взрыхлил, окучил, собрал урожай, засолил, заметил вредителя, обработал от тли, протёр листья, поставил подпорку и т.д. Распознавай по смыслу. Если пользователь просит записать что-то в дневник ("запиши в дневник...") — тип ВСЕГДА "diary", даже если это полив. Действие можно и ПРОШЛОЕ ("удалил сухую ветку") — это всё равно diary-запись, а не команда удаления. ВАЖНО ПРО action: в поле action пиши ТОЛЬКО само действие — КРАТКО, БЕЗ названия растения: "Обрезка сухих веток", "Пикировка", "Рыхление", "Подкормка", "Опрыскивание", "Заметил тлю". Название растения передаётся ТОЛЬКО в поле plant и НИКОГДА не дублируется в action.
7. type = "query_plants" — пользователь ХОЧЕТ УВИДЕТЬ информацию о растениях: "покажи растения", "какие у меня растения", "сколько у меня цветов".
8. type = "query_diary" — пользователь ХОЧЕТ УВИДЕТЬ дневник: "покажи дневник", "что я записывал", "мои заметки", "что было 5 ноября".
9. type = "interval" — пользователь ЗАДАЁТ или МЕНЯЕТ график ухода: "поливай лимон каждые 3 дня", "подкармливай фикус раз в 2 недели", "опрыскивай орхидею кажде 2 дня". В action — "water" (полив), "fertilize" (подкормка/удобрение), "loosen" (рыхление), "spray" (опрыскивание). В plant — растение. В days — число ДНЕЙ между повторами: "раз в 2 недели" = 14, "каждые 3 дня" = 3. ЕСЛИ в сообщении нет явного интервала («каждые N дней», «раз в N недель») — это НЕ interval, а вопрос (type = "question"). Важно: «как часто поливать лимон?» — это question, а не interval.
10. type = "quiet" — пользователь просит НЕ ПИСАТЬ ему ночью: "не буди меня с 22 до 8", "тишина с 23:00 до 07:00", "не пиши ночью". В from — начало тишины (HH:MM), в to — конец (HH:MM). Без указанных часов — from "22:00", to "08:00".
11. type = "help" — пользователь спрашивает, КАК что-то сделать В САМОМ БОТЕ: "как посмотреть паспорт?", "какие есть команды?", "как настроить тишину?", "как удалить растение?", "как записать в дневник?". Вопросы про УХОД ЗА РАСТЕНИЕМ («как опрыскивать орхидею?», «как его поливать?», «как ухаживать за фикусом?») — это НЕ help, это type = "question". В action — id возможности из каталога ниже. НЕ выполняй действие и не отвечай сам — только укажи возможность.
12. type = "question" — вопрос, совет, приветствие, болтовня, благодарность, грубость. ТАКЖЕ: "удали" или "очисти" БЕЗ явного объекта (непонятно, что удалять) — это "question", бот уточнит. Также question — действие с растением, которое нельзя определить: «полил» без названия.

КРИТИЧЕСКОЕ ПРАВИЛО РАЗЛИЧЕНИЯ УДАЛЕНИЙ:
- "удали фикус" / "удали его" → plant_delete
- "удали все растения" / "очисти список" → plant_clear
- "удали все заметки" / "удали все мои заметки" / "очисти дневник" → diary_clear
- "удали" без объекта → question
- "запиши в дневник: удалил ветку" → diary (запись, НЕ команда удаления)

ПРАВИЛА РАЗЛИЧЕНИЯ:
- "как удалить растение?" — это help (вопрос о способе), НЕ plant_delete.
- "А как его опрыскивать?" → {"type":"question","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
- "как часто поливать лимон?" — это question (совет по уходу), НЕ water и НЕ help.
- "завтра обрежу розу" — план, НЕ событие diary. Событие — только то, что УЖЕ случилось.
- НИКОГДА не придумывай команды: пользователь пишет обычным языком, ты возвращаешь только поля схемы.

КАТАЛОГ ВОЗМОЖНОСТЕЙ (id → назначение): растения — plants.list; добавление — plant.add; паспорт — passport.open; графики — schedule.view; забытое растение — plants.top; тишина — quiet.set; удаление — plant.delete; отчёт — report.build; статистика — stats.show; дневник — diary.view; запись в дневник — diary.add; веб-дневник — web.open; память — brain.reset; напоминания — reminders.set; справка — help.show.

КОНТЕКСТ: Если передан блок "[ПОСЛЕДНЕЕ РАСТЕНИЕ: ...]" и пользователь НЕ назвал растение, но подразумевает его ("удали его", "обрезал его вчера", "полил его") — используй это растение в поле plant. Если блока нет и растение не названо — plant = null.

ПОЛЯ:
- action: для diary — краткое название действия БЕЗ названия растения, готовое для дневника: "Обрезка сухих веток", "Пикировка". Для water — "Полив". Для interval — "water"/"fertilize"/"loosen"/"spray". Для help — id возможности из каталога. Для остальных — null.
- plant: название растения ИЗ сообщения или из контекста. Не упомянуто — null. НЕ ВЫДУМЫВАЙ. Для query_plants, query_diary, diary_clear, plant_clear, quiet, help — null.
ВАЖНО: Название растения (поле plant) всегда должно быть в ИМЕНИТЕЛЬНОМ падеже (Кто? Что?). Например, если пользователь пишет "добавь мальпигию голую", в поле plant ты пишешь "Мальпигия голая", а не "мальпигию голую" и по аналогии.
- location: только для plant_add. Нет — null.
- date: ТОЛЬКО если пользователь явно назвал дату ("5 ноября", "вчера", "завтра", "3 октября"). Формат YYYY-MM-DD. "вчера" = сегодня минус один день, "завтра" = плюс один. Нет даты — null.
- days: только для interval — число дней между повторами. Иначе null.
- from/to: только для quiet — границы часов тишины в формате HH:MM. Иначе null.

Примеры (сегодня 2026-11-04):
"Я обрезал сухие ветки у фикуса" → {"type":"diary","action":"Обрезка сухих веток","plant":"фикус","location":null,"date":null,"days":null,"from":null,"to":null}
"полил лимон" → {"type":"water","action":"Полив","plant":"лимон","location":null,"date":null,"days":null,"from":null,"to":null}
"полил" → {"type":"question","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"[ПОСЛЕДНЕЕ РАСТЕНИЕ: фикус] полил его" → {"type":"water","action":"Полив","plant":"фикус","location":null,"date":null,"days":null,"from":null,"to":null}
"опрыскала орхидею" → {"type":"diary","action":"Опрыскивание","plant":"орхидея","location":null,"date":null,"days":null,"from":null,"to":null}
"распикировал помидоры" → {"type":"diary","action":"Пикировка","plant":"помидоры","location":null,"date":null,"days":null,"from":null,"to":null}
"взрыхлил землю у лимона" → {"type":"diary","action":"Рыхление","plant":"лимон","location":null,"date":null,"days":null,"from":null,"to":null}
"купил орхидею на кухню" → {"type":"plant_add","action":null,"plant":"орхидея","location":"кухня","date":null,"days":null,"from":null,"to":null}
"у меня есть лимон" → {"type":"plant_add","action":null,"plant":"лимон","location":null,"date":null,"days":null,"from":null,"to":null}
"удали фикус" → {"type":"plant_delete","action":null,"plant":"фикус","location":null,"date":null,"days":null,"from":null,"to":null}
"удали все растения" → {"type":"plant_clear","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"удали все мои заметки" → {"type":"diary_clear","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"очисти дневник" → {"type":"diary_clear","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"удали" → {"type":"question","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"покажи растения" → {"type":"query_plants","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"что я записывал" → {"type":"query_diary","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"как часто поливать монстеру?" → {"type":"question","action":null,"plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"как посмотреть паспорт?" → {"type":"help","action":"passport.open","plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"какие есть команды?" → {"type":"help","action":"help.show","plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"как удалить растение?" → {"type":"help","action":"plant.delete","plant":null,"location":null,"date":null,"days":null,"from":null,"to":null}
"поливай лимон каждые 3 дня" → {"type":"interval","action":"water","plant":"лимон","location":null,"date":null,"days":3,"from":null,"to":null}
"подкармливай фикус раз в 2 недели" → {"type":"interval","action":"fertilize","plant":"фикус","location":null,"date":null,"days":14,"from":null,"to":null}
"не буди меня с 22 до 8" → {"type":"quiet","action":null,"plant":null,"location":null,"date":null,"days":null,"from":"22:00","to":"08:00"}
"тишина с 23:30 до 07:00" → {"type":"quiet","action":null,"plant":null,"location":null,"date":null,"days":null,"from":"23:30","to":"07:00"}
"собрал урожай помидоров" → {"type":"diary","action":"Собрал урожай","plant":"помидоры","location":null,"date":null,"days":null,"from":null,"to":null}
"заметил тлю на розе" → {"type":"diary","action":"Заметил тлю","plant":"роза","location":null,"date":null,"days":null,"from":null,"to":null}
"запиши в дневник 5 ноября полил помидоры" → {"type":"diary","action":"Полив","plant":"помидоры","location":null,"date":"2026-11-05","days":null,"from":null,"to":null}
"запиши в дневник: удалил сухую ветку у лимона" → {"type":"diary","action":"Удалил сухую ветку","plant":"лимон","location":null,"date":null,"days":null,"from":null,"to":null}
"[ПОСЛЕДНЕЕ РАСТЕНИЕ: фикус] удали его" → {"type":"plant_delete","action":null,"plant":"фикус","location":null,"date":null,"days":null,"from":null,"to":null}`;

function extractJson(text) {
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (e) { return null; }
}

function safeDate(d) {
    if (typeof d !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const [y, m, day] = d.split('-').map(Number);
    const parsed = new Date(y, m - 1, day);
    if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== day) return null;
    if (parsed > new Date()) return null;
    return d;
}

function safeStr(s, maxLen = 200) {
    if (typeof s !== 'string') return null;
    const trimmed = s.trim();
    return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null;
}

function safeTime(t) {
    if (typeof t !== 'string') return null;
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function detectDeleteTarget(userText) {
    const lower = (userText || '').toLowerCase();
    const saysDiary = /заметк|дневник|запис/.test(lower);
    const saysPlants = /растени|цвет\w*|сад|огород|грядк|культур/.test(lower);
    if (saysDiary && saysPlants) return 'ambiguous';
    if (saysDiary) return 'diary';
    if (saysPlants) return 'plants';
    return null;
}

function questionResult() {
    return { type: 'question', action: null, plant: null, location: null, date: null, days: null, from: null, to: null };
}

const STOP_WORDS = /^(и|а|но|в|во|на|с|со|у|к|по|за|из|от|до|для|при|о|об|вчера|сегодня|завтра|его|её|их|это|всё|все|хлеб|молоко|еду|магазин)$/i;

function detectWaterRule(text) {
    const m = text.match(/^полил[а]?\s+([а-яё]+)/i);
    if (!m || STOP_WORDS.test(m[1])) return null;
    return { type: 'water', action: 'Полив', plant: m[1], location: null, date: null, days: null, from: null, to: null };
}

function detectAddRule(text) {
    // Захватывает всё до конца строки (кавычки, латиницу)
    const m = text.match(/^(добавь|посадил[а]?|купил[а]?)\s+(.+)/i);
    if (!m) return null;
    let plantName = m[2].trim();
    if (STOP_WORDS.test(plantName)) return null;
    // Убираем слово "сорта", чтобы было чище
    plantName = plantName.replace(/\s+сорта\s+/i, ' ');
    return { type: 'plant_add', action: null, plant: plantName, location: null, date: null, days: null, from: null, to: null };
}

function detectDeleteRule(text) {
    const m = text.match(/^(удали|выбросил[а]?)\s+([а-яё]+)/i);
    if (!m || STOP_WORDS.test(m[2])) return null;
    if (/^(все|всё|весь|всю)$/i.test(m[2])) return null;
    return { type: 'plant_delete', action: null, plant: m[2], location: null, date: null, days: null, from: null, to: null };
}

function detectIntervalRule(text) {
    const m = text.match(/(полива\S*|подкармл\S*|удобр\S*|рыхл\S*|опрыск\S*)\s+([а-яё]+)\s+(?:кажды\S*|раз\s+в)\s+(\d+)\s*(дн\S*|недел\S*)?/i);
    if (!m || STOP_WORDS.test(m[2])) return null;
    const word = m[1].toLowerCase();
    const action = /полив/.test(word) ? 'water'
        : /подкорм|удобр/.test(word) ? 'fertilize'
        : /рыхл/.test(word) ? 'loosen'
        : 'spray';
    let days = parseInt(m[3], 10);
    if (m[4] && /недел/i.test(m[4])) days *= 7;
    if (!(days >= 1 && days <= 90)) return null;
    return { type: 'interval', action, plant: m[2], location: null, date: null, days, from: null, to: null };
}

function detectQuietRule(text) {
    if (!/не буди|не будить|тишин|не беспоко/i.test(text)) return null;
    const nums = [...text.matchAll(/(\d{1,2})(?:[:.](\d{2}))?/g)];
    if (nums.length >= 2) {
        const from = `${nums[0][1]}:${nums[0][2] || '00'}`;
        const to = `${nums[1][1]}:${nums[1][2] || '00'}`;
        if (safeTime(from) && safeTime(to)) {
            return { type: 'quiet', action: null, plant: null, location: null, date: null, days: null, from, to };
        }
    }
    return { type: 'quiet', action: null, plant: null, location: null, date: null, days: null, from: '22:00', to: '08:00' };
}

function detectHelpRule(text) {
    const lower = (text || '').toLowerCase();
    const careVerbs = /опрыск|полив|подкорм|удобр|пересад|обрез|рыхл|прищип|ухажив/i;
    const mentionsPlant = /\b(его|её|их|него|нее)\b|фикус|орхиде|лимон|кактус|роз|помидор|томат|монстер|фиалк|геран|алоэ|суккулент|рассад|цвет|растен/i;
    if (careVerbs.test(lower) && mentionsPlant.test(lower)) return null;
    if (!/^(как|что)(?:\s|$)/i.test(text)) return null;
    if (!/как(?:ой|им)?\s|что\s/.test(text)) return null;
    const checks = [
        { re: /паспорт/i, id: 'passport.open' },
        { re: /график\S*\s*(уход|полив|подкорм|рыхл|опрыск)/i, id: 'schedule.view' },
        { re: /команд|умеешь|можешь|возможност/i, id: 'help.show' },
        { re: /напоминан/i, id: 'quiet.set' },
        { re: /тишин/i, id: 'quiet.set' },
        { re: /отч[её]т/i, id: 'report.build' },
        { re: /статистик/i, id: 'stats.show' },
        { re: /дневник/i, id: 'diary.view' },
        { re: /очистить.*память|сбросить.*память/i, id: 'brain.reset' }
    ];
    for (const c of checks) {
        if (c.re.test(text)) return { type: 'help', action: c.id, plant: null, location: null, date: null, days: null, from: null, to: null };
    }
    return null;
}

function normalizeResult(obj, userText) {
    if (!obj || !VALID_TYPES.includes(obj.type)) return null;
    const clean = {
        type: obj.type,
        action: safeStr(obj.action),
        plant: safeStr(obj.plant, 100),
        location: safeStr(obj.location, 50),
        date: safeDate(obj.date),
        days: Number.isFinite(obj.days) ? parseInt(obj.days, 10) : null,
        from: safeTime(obj.from),
        to: safeTime(obj.to)
    };
    if ((clean.type === 'water' || clean.type === 'plant_add' || clean.type === 'plant_delete') && !clean.plant) {
        return questionResult();
    }
    if (clean.type === 'diary' && !clean.action) clean.type = 'question';

    if (clean.type === 'help') {
        const careVerbs = /опрыск|полив|подкорм|удобр|пересад|обрез|рыхл|прищип|ухажив/i;
        if (careVerbs.test((userText || '').toLowerCase())) {
            return questionResult();
        }
        clean.action = HELP_IDS.includes(clean.action) ? clean.action : 'help.show';
    }

    if (clean.type === 'interval' && (!clean.plant || !clean.days || clean.days < 1 || clean.days > 90)) {
        return questionResult();
    }
    if (clean.type === 'quiet' && (!clean.from || !clean.to)) {
        return questionResult();
    }

    const DELETE_TYPES = ['plant_delete', 'plant_clear', 'diary_clear'];
    if (DELETE_TYPES.includes(clean.type)) {
        const lower = (userText || '').toLowerCase();
        const target = detectDeleteTarget(userText);
        if (target === 'diary') {
            const saysAll = /все|весь|всю|полностью|очист|подчист/.test(lower);
            return saysAll ? { type: 'diary_clear', action: null, plant: null, location: null, date: null, days: null, from: null, to: null } : questionResult();
        }
        if (target === 'plants') {
            const saysAll = /все|весь|всю|полностью|очист|подчист/.test(lower);
            if (saysAll) return { type: 'plant_clear', action: null, plant: null, location: null, date: null, days: null, from: null, to: null };
            if (!clean.plant) return questionResult();
            return { type: 'plant_delete', action: null, plant: clean.plant, location: null, date: null, days: null, from: null, to: null };
        }
        if (target === 'ambiguous') return questionResult();
        if (clean.type === 'plant_delete' && clean.plant) return clean;
        return questionResult();
    }
    return clean;
}

async function parseAction(callLlm, userText, lastPlant = null) {
    try {
        const quiet = detectQuietRule(userText);
        if (quiet) return quiet;
        const help = detectHelpRule(userText);
        if (help) return help;
        
        const water = detectWaterRule(userText);
        if (water) return water;
        const add = detectAddRule(userText);
        if (add) return add;
        const del = detectDeleteRule(userText);
        if (del) return del;
        
        const interval = detectIntervalRule(userText);
        if (interval) return interval;

        const today = new Date().toISOString().split('T')[0];
        let userPrompt = `Сегодня ${today}. Сообщение пользователя: "${userText}"`;
        if (lastPlant) {
            userPrompt += `\n[ПОСЛЕДНЕЕ РАСТЕНИЕ: ${lastPlant}]`;
        }

        const raw = await callLlm([
            { role: "system", content: JARVIS_SYSTEM_PROMPT },
            { role: "user", content: userPrompt }
        ]);

        if (!raw) return null;
        return normalizeResult(extractJson(raw), userText);
    } catch (e) {
        return null;
    }
}

module.exports = { parseAction, COMMAND_GROUPS, COMMAND_BY_ID };