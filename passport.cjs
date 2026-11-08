const path = require('path');
const { readJsonSafe, writeJsonSafe } = require('./utils.cjs');

const PLANTS_FILE = path.join(__dirname, 'plants.json');
const RULES_FILE = path.join(__dirname, 'care_rules.json'); 
const sessions = new Map();

const DEFAULTS = { water: 4, fertilize: 14, loosen: 14, spray: 3 };
const LABELS = { water: 'Полив', fertilize: 'Подкормка', loosen: 'Рыхление', spray: 'Опрыскивание' };

function nameStem(name) {
    return String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]/g, '').slice(0, 5);
}
function isSamePlant(a, b) {
    const sa = nameStem(a), sb = nameStem(b);
    if (!sa || !sb) return false;
    return sa === sb || sa.startsWith(sb) || sb.startsWith(sa);
}

const HOME_WORDS = ['дом', 'квартир', 'комнат', 'подокон', 'кухн', 'балкон', 'лоджи', 'спальн', 'зал', 'гостин', 'кабинет', 'офис', 'коридор', 'оранжер'];
const OUT_WORDS = ['улиц', 'огород', 'сад', 'дач', 'теплиц', 'грядк', 'двор', 'террас'];
function detectPlace(location) {
    const loc = String(location || '').toLowerCase().replace(/ё/g, 'е');
    if (!loc.trim()) return null;
    if (OUT_WORDS.some(w => loc.includes(w))) return 'улица';
    if (HOME_WORDS.some(w => loc.includes(w))) return 'дома';
    return null;
}

function readPlants(chatId) {
    const data = readJsonSafe(PLANTS_FILE, []);
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.plants) ? data.plants : []);
    return chatId ? list.filter(p => String(p.userId) === String(chatId)) : list;
}

function savePlants(chatId, updater) {
    const data = readJsonSafe(PLANTS_FILE, []);
    const all = Array.isArray(data) ? data : (data && Array.isArray(data.plants) ? data.plants : []);
    const updated = updater(all.filter(p => String(p.userId) === String(chatId)));
    writeJsonSafe(PLANTS_FILE, all.filter(p => String(p.userId) !== String(chatId)).concat(updated));
}

function findPlant(name, chatId) {
    return readPlants(chatId).find(p => isSamePlant(p.name || p.id, name)) || null;
}

function tryFixName(name) {
    if (!name) return 'Растение';
    const match = name.match(/^(.+?)(\s*«.+»)?$/);
    if (!match) return name;
    let mainPart = match[1].trim();
    const sortPart = match[2] || ''; 
    const words = mainPart.split(/\s+/);
    const fixedWords = words.map((word, index) => {
        if (/[a-z0-9]/i.test(word)) return word;
        let n = word.toLowerCase();
        if (n.endsWith('ую') || n.endsWith('юю')) n = n.slice(0, -2) + (n.endsWith('юю') ? 'яя' : 'ая');
        else if (n.endsWith('ого') || n.endsWith('его')) n = n.slice(0, -3) + 'ый';
        else if (n.endsWith('у') || n.endsWith('ю')) n = n.slice(0, -1) + 'а';
        else if (n.endsWith('ой') || n.endsWith('ей')) n = n.slice(0, -2) + 'а';
        if (index === 0) return n.charAt(0).toUpperCase() + n.slice(1);
        return n;
    });
    return fixedWords.join(' ') + sortPart;
}

function findRulesInDb(plantName) {
    const rules = readJsonSafe(RULES_FILE, {});
    const lowerName = String(plantName).toLowerCase().replace(/ё/g, 'е').trim();
    
    if (rules[lowerName]) return rules[lowerName];
    
    let bestMatch = null;
    let bestLength = 0;
    
    for (const [key, value] of Object.entries(rules)) {
        const k = key.toLowerCase().replace(/ё/g, 'е');
        if (lowerName.includes(k) || k.includes(lowerName)) {
            if (k.length > bestLength) {
                bestLength = k.length;
                bestMatch = value;
            }
        }
    }
    return bestMatch;
}

function applyConditions(baseSch, baseAdv, cond) {
    const sch = { ...baseSch };
    const adv = { ...baseAdv };

    if (cond.window && cond.window !== 'не знаю') {
        if (/южн/i.test(cond.window) && sch.water > 1) {
            sch.water = Math.max(2, sch.water - 1);
            adv.water = (adv.water || '') + " На южном окне земля сохнет быстрее.";
        } else if (/север/i.test(cond.window)) {
            sch.water += 1;
            adv.water = (adv.water || '') + " На северном окне полив можно делать реже.";
        }
    }

    if (cond.pot && cond.pot !== 'не знаю') {
        if (/больш/i.test(cond.pot)) {
            sch.water += 1;
            adv.water = (adv.water || '') + " В большом горшке земля сохнет медленнее.";
        } else if (/мален/i.test(cond.pot) && sch.water > 2) {
            sch.water -= 1;
            adv.water = (adv.water || '') + " Маленький горшок пересыхает быстро.";
        }
    }

    if (cond.location === 'улица') {
        if (sch.water > 2) sch.water -= 1;
        adv.water = (adv.water || '') + " На улице ветер и солнце сушат быстрее.";
        if (sch.spray > 0) { sch.spray = 0; adv.spray = "На улице опрыскивание не требуется."; }
    }

    return { schedule: sch, advice: adv };
}

function buildSchedule(s) {
    const p = s.data;
    const lowerName = String(p.name).toLowerCase().replace(/ё/g, 'е');
    
    // 🔥 1. ЗАЩИТА ОТ БИОЛОГИЧЕСКОГО АБСУРДА (Паразиты, реликты, деревья-гиганты)
    if (/раффлези|повилик|заразих|петров крест|подъельник|омела|вельвичи|баобаб|секвойя|перекати.?поле|сейба|драконово дерево/i.test(lowerName)) {
        return {
            error: `Похоже, вы пытаетесь добавить «${p.name}». Это растение-паразит, реликт или гигантское дерево, которое не выращивают в горшках или на обычных грядках. Я не могу составить для него график ухода в рамках этого бота.`
        };
    }

    // 🔥 2. ГЛОБАЛЬНАЯ ЗАЩИТА ДЛЯ БОЛОТНЫХ РАСТЕНИЙ
    if (/циперус|папирус|ситник|камыш|рогоз|тростник|аквилегия.*болотн|калужница|белокрыльник|сфагнум|болотн|водн/i.test(lowerName)) {
        return {
            schedule: { water: 1, fertilize: 30, loosen: 0, spray: 3 },
            advice: {
                water: "Болотное/водное растение: грунт всегда мокрый, горшок в поддоне с водой. Полив ежедневный или долив.",
                fertilize: "Умеренное, раз в месяц в период роста.",
                loosen: "Не требуется: корневая система поверхностная, рыхление травмирует.",
                spray: "Любит высокую влажность воздуха."
            }
        };
    }

    // 🔥 3. Ищем строгие правила в care_rules.json
    const strictRules = findRulesInDb(p.name);
    
    if (strictRules) {
        return { 
            schedule: { water: strictRules.water, fertilize: strictRules.fertilize, loosen: strictRules.loosen, spray: strictRules.spray },
            advice: { water: strictRules.advice_water, fertilize: strictRules.advice_fertilize, loosen: strictRules.advice_loosen, spray: strictRules.advice_spray }
        };
    }

    // 🔥 4. Если нет в базе — дефолт и модификаторы
    let baseSch = { ...DEFAULTS };
    let baseAdv = { water: "Полив по просыханию верхнего слоя.", fertilize: "Умеренное, в период роста.", loosen: "Аккуратно рыхлить верхний слой.", spray: "Умеренная влажность воздуха." };

    if (/кактус|суккулент|алоэ|крассула|толстянк|эхеверия/i.test(lowerName)) {
        baseSch.water = 14;
        baseAdv.water = "Суккулент. Полив редкий, по полному просыханию.";
    }

    const cond = { location: p.location, window: p.window, pot: p.pot };
    return applyConditions(baseSch, baseAdv, cond);
}

function scheduleText(s) {
    if (s.facts && s.facts.error) {
        return `⚠️ ${s.facts.error}`;
    }

    const name = s.fixedName || s.data.name;
    
    if (s.facts && s.facts.schedule) {
        const sch = s.facts.schedule;
        const adv = s.facts.advice || {};

        const formatBlock = (key, label) => {
            const days = sch[key];
            if (days === 0) return `**${label}:** _не требуется_`;
            
            let adviceText = adv[key] ? String(adv[key]).trim() : '';
            const adviceStr = adviceText ? `\n_${adviceText}_` : '';
            
            return `**${label}:** каждые ${days} дн.${adviceStr}`;
        };

        return `📋 **Расписание для «${name}»**\n\n` +
            `${formatBlock('water', '💧 Полив')}\n\n` +
            `${formatBlock('fertilize', '🌱 Подкормка')}\n\n` +
            `${formatBlock('loosen', '🪴 Рыхление')}\n\n` +
            `${formatBlock('spray', '💦 Опрыскивание')}`;
    }

    return `📋 Расписание для «${name}»:\n_Данных нет_`;
}

function startPassport(send, chatId, askLLM, plantName, knownLocation = null, successMsg = null) {
    const s = { name: plantName, data: { name: plantName }, step: 'location', askLLM, successMsg };
    const place = knownLocation ? detectPlace(knownLocation) : null;
    if (place) {
        s.data.location = place;
        if (place === 'улица') {
            s.step = 'street_pot';
            send(chatId, `Заполняем паспорт «${plantName}» 🪴 Место я уже знаю — улица.\n\nШаг 2. Он растет в горшке или в открытом грунте? (Напиши: горшок / грунт). Чтобы прервать — напиши «отмена».`);
        } else {
            s.step = 'window';
            send(chatId, `Заполняем паспорт «${plantName}» 🪴 Место я уже знаю — ${place}.\n\nШаг 2. Какое освещение? Южное / северное / восточное / западное (или «не знаю»). Чтобы прервать — напиши «отмена».`);
        }
    } else {
        send(chatId, `Заполняем паспорт «${plantName}» 🪴\n\nШаг 1. Где он живёт? Напиши: дома / улица (или «не знаю»). Чтобы прервать — напиши «отмена».`);
    }
    sessions.set(String(chatId), s);
}

function hasSession(chatId) { return sessions.has(String(chatId)); }
function clearSession(chatId) { sessions.delete(String(chatId)); }

function applySchedule(send, chatId, s) {
    const target = findPlant(s.data.name, chatId);
    if (!target) { sessions.delete(String(chatId)); send(chatId, `Хм, «${s.data.name}» в списке растений не нашёл.`); return; }
    const targetId = target.id;
    savePlants(chatId, list => list.map(p => {
        if (String(p.id) !== String(targetId)) return p;
        const q = { ...p };
        if (s.fixedName) q.name = s.fixedName; 
        q.location = s.data.location || 'дома'; 
        q.passport = { location: s.data.location, window: s.data.window || 'улица', soil: s.data.soil || 'улица', pot: s.data.pot || 'открытый грунт', notes: s.data.notes || '', filledAt: new Date().toISOString().slice(0, 10) };
        q.schedule = {};
        for (const k of Object.keys(DEFAULTS)) q.schedule[k] = { intervalDays: s.facts.schedule[k], source: 'base', confirmed: true };
        if (q.schedule.water) q.daysInterval = q.schedule.water.intervalDays; 
        return q;
    }));
    sessions.delete(String(chatId));
    if (s.successMsg) {
        let msg = s.successMsg;
        if (s.fixedName && s.successMsg.includes(s.data.name)) msg = s.successMsg.replace(s.data.name, s.fixedName);
        send(chatId, msg);
    }
    send(chatId, `Готово! Паспорт и расписание «${s.fixedName || target.name}» сохранены 🌿 Теперь я сам слежу за сроками.`);
}

function handleInput(chatId, text, send) {
    const s = sessions.get(String(chatId));
    if (!s) return false;
    const t = text.trim().toLowerCase();

    if (/^(отмен|стоп|хватит|позже)/i.test(t)) {
        sessions.delete(String(chatId));
        if (s.successMsg) {
            let msg = s.successMsg;
            if (s.fixedName && s.successMsg.includes(s.data.name)) msg = s.successMsg.replace(s.data.name, s.fixedName);
            send(chatId, msg); 
        }
        send(chatId, 'Ладно, паспорт потом. Продолжить: напиши «паспорт» + название растения.');
        return true;
    }

    if (s.step === 'location') {
        if (/не знаю/i.test(t)) s.data.location = 'дома';
        else {
            const place = detectPlace(t);
            if (!place) { send(chatId, 'Не понял. Напиши, где растение: дома, на подоконник, на балконе, на улице — или «не знаю».'); return true; }
            s.data.location = place;
        }
        if (s.data.location === 'улица') {
            s.step = 'street_pot';
            send(chatId, 'Шаг 2. Он растет в горшке или в открытом грунте? (Напиши: горшок / грунт).');
        } else {
            s.step = 'window';
            send(chatId, `Шаг 2. Какое освещение у «${s.data.name}»? Южное / северное / восточное / западное / не знаю.`);
        }
        return true;
    }

    if (s.step === 'street_pot') {
        if (/грунт|огород|грядк|земл/i.test(t)) {
            s.data.pot = 'открытый грунт'; s.step = 'notes';
            send(chatId, 'Шаг 3. Что-то важное про растение? Напиши или «пропустить».');
        } else if (/горш|вазон|кадк/i.test(t)) {
            s.data.pot = 'горшок'; s.step = 'notes';
            send(chatId, 'Шаг 3. Что-то важное про растение? Напиши или «пропустить».');
        } else { send(chatId, 'Напиши, пожалуйста: горшок или грунт.'); }
        return true;
    }

    if (s.step === 'window') {
        if (/не знаю/i.test(t)) s.data.window = 'не знаю';
        else if (/южн/i.test(t)) s.data.window = 'южное';
        else if (/север/i.test(t)) s.data.window = 'северное';
        else if (/запад/i.test(t)) s.data.window = 'западное';
        else if (/восточ|восток/i.test(t)) s.data.window = 'восточное'; 
        else { send(chatId, 'Не понял. Напиши: южное, северное, восточное, западное или «не знаю».'); return true; }
        s.step = 'soil';
        send(chatId, 'Шаг 3. Какой грунт? Например: универсальный, кактусный, для цитрусовых — или «не знаю».');
        return true;
    }
    if (s.step === 'soil') {
        s.data.soil = /не знаю/i.test(t) ? 'не знаю' : text.trim();
        s.step = 'pot';
        send(chatId, 'Шаг 4. Горшок какой? Маленький / средний / большой (или «не знаю»).');
        return true;
    }
    if (s.step === 'pot') {
        s.data.pot = /не знаю/i.test(t) ? 'не знаю' : text.trim();
        s.step = 'notes';
        send(chatId, 'Шаг 5. Что-то важное про растение? Напиши или «пропустить».');
        return true;
    }
    if (s.step === 'notes') {
        s.data.notes = /пропустить/i.test(t) ? '' : text.trim();
        s.step = 'generating';
        
        send(chatId, 'Секунду, ищу точные данные в базе… 🌿');
        
        s.facts = buildSchedule(s); 
        
        // Если возникла ошибка (растение-паразит)
        if (s.facts.error) {
            const errorText = scheduleText(s);
            send(chatId, errorText);
            // Удаляем это растение, так как ухаживать за ним нельзя
            const target = findPlant(s.data.name, chatId);
            if (target) {
                savePlants(chatId, list => list.filter(p => String(p.id) !== String(target.id)));
            }
            sessions.delete(String(chatId));
            return true;
        }

        s.step = 'confirm';
        const textSchedule = scheduleText(s);
        
        send(chatId, textSchedule + '\n\n«Согласен» — или «хочу поправить»?');
        return true;
    }
    if (s.step === 'confirm') {
        if (/согласен|да|ок|окей|норм|давай/i.test(t)) { applySchedule(send, chatId, s); return true; }
        if (/поправ|измен|другой|другое/i.test(t)) {
            s.step = 'adjust';
            send(chatId, 'Что поправить? Пример: «полив каждые 3 дня, удобрение раз в 2 недели».');
            return true;
        }
        send(chatId, 'Напиши «согласен» или «хочу поправить» (и что именно).');
        return true;
    }
    if (s.step === 'adjust') {
        const days = parseAdjust(text);
        if (!Object.keys(days).length) {
            send(chatId, 'Не распознал. Пример: «полив каждые 3 дня, удобрение раз в 2 недели».');
            return true;
        }
        for (const [k, v] of Object.entries(days)) s.facts.schedule[k] = v; 
        s.step = 'confirm';
        const textSchedule = scheduleText(s);
        send(chatId, 'Принял! Теперь график такой:\n\n' + textSchedule + '\n\n«Согласен» — или ещё поправим?');
        return true;
    }
    return false;
}

function showPassport(plantName, send, chatId) {
    const p = findPlant(plantName, chatId);
    if (!p) { send(chatId, `«${plantName}» не нашёл. Посмотри /plants — там точные названия.`); return; }
    const pp = p.passport || {};
    const sched = p.schedule
        ? Object.entries(LABELS).filter(([k]) => p.schedule[k]).map(([k, l]) => `• ${l}: ${p.schedule[k].intervalDays === 0 ? 'не требуется' : 'каждые ' + p.schedule[k].intervalDays + ' дн.'}`).join('\n')
        : 'ещё не составлено — напиши «паспорт» + название растения';
    send(chatId, `🌿 ${p.name} — паспорт\n\n• Место: ${pp.location || 'не указано'}\n• Освещение: ${pp.window || 'не указано'}\n• Грунт: ${pp.soil || 'не указано'}\n• Горшок: ${pp.pot || 'не указано'}\n• С нами с: ${pp.filledAt || 'не помню'}\n• Особенности: ${pp.notes || 'нет'}\n\n📅 Уход:\n${sched}`);
}

function setIntervalDirect(plantName, action, days, chatId) {
    if (!DEFAULTS[action] || !Number.isFinite(days) || days < 1 || days > 90) return false;
    const target = findPlant(plantName, chatId);
    if (!target) return false;
    const targetId = target.id;
    savePlants(chatId, list => list.map(p => {
        if (String(p.id) !== String(targetId)) return p;
        const q = { ...p };
        q.schedule = q.schedule || {};
        q.schedule[action] = { intervalDays: days, source: 'user', confirmed: true };
        if (action === 'water') q.daysInterval = days;
        return q;
    }));
    try {
        const reminders = require('./reminders.cjs');
        reminders.markActionDone(chatId, target.id, action);
    } catch (e) {}
    return true;
}

function parseAdjust(text) {
    const result = {};
    const mapSyn = [[/полив/i, 'water'], [/удобр|подкорм/i, 'fertilize'], [/рыхл/i, 'loosen'], [/опрыск|брызг/i, 'spray']];
    const re = /(полив\S*|удобрен\S*|подкорм\S*|рыхлен\S*|опрыскиван\S*)[^0-9]*(\d+)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const act = (mapSyn.find(([rx]) => rx.test(m[1])) || [])[1];
        if (!act) continue;
        let days = parseInt(m[2], 10);
        const tail = text.slice(m.index, m.index + 60);
        if (/недел/i.test(tail)) days *= 7;
        if (Number.isFinite(days) && days >= 1 && days <= 90) result[act] = days;
    }
    return result;
}

function defaultsFor(name) {
    const d = { ...DEFAULTS };
    if (/кактус|суккулент|алоэ|крассула|толстянк|эхеверия/i.test(name)) { d.water = 14; d.fertilize = 30; d.loosen = 30; d.spray = 0; }
    else if (/орхидея|фаленопсис/i.test(name)) { d.water = 7; d.fertilize = 21; d.loosen = 0; d.spray = 3; }
    else if (/лимон|цитрус|мандарин|апельсин/i.test(name)) d.water = 4;
    return d;
}

module.exports = { startPassport, hasSession, handleInput, showPassport, setIntervalDirect, defaultsFor, detectPlace, clearSession };