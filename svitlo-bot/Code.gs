/**
 * ШАБЛОН бота «Світло» для ЖК (Telegram + Google Apps Script + Cloudflare Worker)
 * Сигнал «світло є / немає» — з публічного каналу Світлобота вашого ЖК.
 * Графіки — з каналів ДТЕК (за номером черги) і з каналу Світлобота (за адресою).
 *
 * ▶ ДЛЯ НОВОГО ЖК ЗМІНІТЬ ЛИШЕ ПОЗНАЧЕНЕ «← ЗМІНИТИ» (3 місця):
 *   1) CFG       — назва ЖК, канал Світлобота, вулиця, назва й адреса бота
 *   2) SCHED     — GROUP: черга ДТЕК (напр. '5.2')
 *   3) SOS       — HOUSES: номери будинків, ENTRANCES: скільки підʼїздів показувати
 * Решту коду не чіпайте.
 *
 * Команди бота:
 *   /start  – підписатися      /stop – відписатися
 *   /status – поточний стан     /id   – дізнатися свій ID
 *   /grafik – графік відключень /admin – усі команди адміністратора
 *
 * Властивості скрипта (Налаштування проєкту → Властивості скрипта):
 *   TG_TOKEN    – токен бота від @BotFather
 *   TG_ADMIN_ID – ваш особистий ID (отримати: написати боту /id)
 *   CF_KEY      – секретний ключ (той самий, що SEND_KEY у Cloudflare)
 *   PROXY_URL   – адреса Cloudflare Worker (…workers.dev), BROADCAST_VIA_CF = 1
 *   LIFT_PHONE  – номер аварійки ліфтів (необовʼязково), DONATE_URL – банка (необовʼязково)
 */

/****************** НАЛАШТУВАННЯ ******************/
const CFG = {
  TZ: 'Europe/Kiev',
  SHEET_NAME: 'Світло',
  SUBS_SHEET: 'Підписники',
  NAME: 'НАЗВА ЖК',                     // ← ЗМІНИТИ: назва ЖК у повідомленнях, напр. 'Софіївська Сфера'
  SIGNAL_CHANNEL: 'svitlobot_xxx',      // ← ЗМІНИТИ: канал Світлобота БЕЗ @ (з посилання t.me/svitlobot_xxx)
  SIGNAL_LABEL: 'Світлобота «НАЗВА»',   // ← ЗМІНИТИ: «Дані про світло — від …» у привітанні
  STREET: 'вул. НАЗВА',                 // ← ЗМІНИТИ: вулиця над вибором будинку ('' — не показувати)
  SIGNAL_FRESH_MIN: 30,            // подію старшу за стільки хв (напр. після збою) лише записуємо, без розсилки
  NIGHT_FROM: 23, NIGHT_TO: 7,     // нічний режим: повідомлення без звуку
  REPORT_HOUR: 8,                  // о котрій надсилати ранкове повідомлення (відключення за ніч + графік на сьогодні)
  CHECK_EVERY_MIN: 1,              // як часто читати канал Світлобота, хв
  SLOW_EVERY_MIN: 2,               // запасний режим: якщо прогноз на добу > 85% ліміту Google — автоматично раз на 2 хв
  DAILY_LIMIT_MIN: 90,             // ліміт Google на роботу тригерів за добу (звичайний Gmail — 90 хв)
  BOT_NAME: 'НАЗВА Світло',             // ← ЗМІНИТИ: назва-посилання на бота в підписі під повідомленнями
  BOT_URL: 'https://t.me/ВАШ_БОТ',      // ← ЗМІНИТИ: адреса бота
  DONATE_TEXT: 'На каву',          // текст посилання на банку (саме посилання — у властивості DONATE_URL)
};
/**************************************************/

// ===== 1. Запустити один раз: створює листи і ставить перевірку щохвилини =====
function setup() {
  sheet_(); subsSheet_();
  // спершу створюємо новий тригер (щохвилини), потім прибираємо старі — щоб перевірка не зникла
  const fresh = ScriptApp.newTrigger('check').timeBased().everyMinutes(1).create();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'check' && t.getUniqueId() !== fresh.getUniqueId())
    .forEach(t => ScriptApp.deleteTrigger(t));
  // без вебхука бот читає повідомлення щохвилини через getUpdates
  if (PropertiesService.getScriptProperties().getProperty('WEBHOOK') !== '1')
    UrlFetchApp.fetch(tgUrl_('deleteWebhook'), { muteHttpExceptions: true });
  setCommands_();
  console.log('Готово: повна перевірка раз на ' + CFG.CHECK_EVERY_MIN + ' хв.');
}

// ===== 2. Перевірка: що бот бачить у каналі Світлобота (нічого не розсилає) =====
function test() {
  const ev = signalEvents_();
  console.log('Подій «світло є/немає» на сторінці @' + CFG.SIGNAL_CHANNEL + ': ' + ev.length);
  ev.slice(-8).forEach(e => console.log('  пост ' + e.id + ': ' + Utilities.formatDate(new Date(e.t), CFG.TZ, 'dd.MM HH:mm') +
    ' — ' + (e.on ? 'світло з\'явилося' : 'світло зникло')));
  const last = ev[ev.length - 1];
  console.log('Зараз за даними Світлобота: ' + (last ? (last.on ? 'світло Є' : 'світла НЕМАЄ') : 'невідомо'));
  console.log('Підписників: ' + subs_().length);
}

// Події з каналу Світлобота: [{id, t, on}] від старих до нових.
// Формат постів: «🔴 01:02 Світло зникло» / «🟢 03:06 Світло з'явилося». Решту постів (графіки, коментарі адміна) пропускаємо.
function signalEvents_() {
  const out = [];
  channelPosts_(CFG.SIGNAL_CHANNEL).forEach(post => {
    const m = post.text.match(/(?:^|\s)(\d{1,2}):(\d{2})\s+Світло\s+(зникло|з.явилос[яь])/i);
    if (!m || !post.time) return;
    // дата — з часу публікації (за Києвом), час — із тексту; якщо вийшло «в майбутньому» — подія була вчора (північ)
    const day = Utilities.formatDate(new Date(post.time), CFG.TZ, 'yyyy-MM-dd');
    let t;
    try { t = Utilities.parseDate(day + ' ' + m[1].padStart(2, '0') + ':' + m[2], CFG.TZ, 'yyyy-MM-dd HH:mm').getTime(); }
    catch (e) { return; }
    if (t > post.time + 5 * 60000) t -= 864e5;
    out.push({ id: post.id, t: t, on: !/зникло/i.test(m[3]) });
  });
  return out;
}

// ===== Основна перевірка (запускається тригером щохвилини) =====
function check() {
  // якщо перевірки щохвилини запускає Cloudflare — тригер Google лише страхує (завершується за мить)
  const tick = Number(PropertiesService.getScriptProperties().getProperty('CF_TICK') || 0);
  if (Date.now() - tick < CF.TICK_FRESH_MS) return;
  runCheck_(false);
}

// fromCf — запуск від Cloudflare (через веб-застосунок: не витрачає 90-хвилинний ліміт тригерів Google)
function runCheck_(fromCf) {
  const t0 = Date.now();
  // повна перевірка — раз на CHECK_EVERY_MIN хв; решта запусків завершуються за мить
  const props = PropertiesService.getScriptProperties();
  try { sosTick_(); } catch (e) { console.error('SOS: ' + e); }
  if (t0 - Number(props.getProperty('LAST_CHECK') || 0) < (fromCf ? CFG.CHECK_EVERY_MIN : checkEvery_()) * 60000 - 20000) return;
  props.setProperty('LAST_CHECK', String(t0));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return fromCf ? null : usage_(t0);
  try {
    try { pollBot_(); } catch (e) { console.error('Бот: ' + e); }
    try { pollSchedule_(); } catch (e) { console.error('Графік: ' + e); }
    try { remind_(); } catch (e) { console.error('Нагадування: ' + e); }

    const p = PropertiesService.getScriptProperties();
    try { morningReport_(new Date()); } catch (e) { console.error('Звіт: ' + e); }

    const events = signalEvents_();
    if (!events.length) return;
    const seen = Number(p.getProperty('SIG_SEEN') || 0);
    const label = 'Світлобот @' + CFG.SIGNAL_CHANNEL;

    if (!p.getProperty('STATE') || !seen) { // перший запуск — лише запам'ятовуємо стан за останнім постом
      const last = events[events.length - 1];
      p.setProperties({ STATE: last.on ? 'ON' : 'OFF', SINCE: String(last.t), SIG_SEEN: String(last.id) });
      log_(new Date(last.t), 'Старт моніторингу: світло ' + (last.on ? 'є' : 'немає'), '', label);
      return;
    }

    events.filter(e => e.id > seen).forEach(e => {
      p.setProperty('SIG_SEEN', String(e.id)); // спершу запам'ятовуємо, щоб не розіслати двічі
      const cur = e.on ? 'ON' : 'OFF';
      if (cur === p.getProperty('STATE')) return; // повтор того ж стану
      const since = Number(p.getProperty('SINCE') || e.t);
      const duration = fmtDur_(Math.max(0, e.t - since));
      p.setProperties({ STATE: cur, SINCE: String(e.t) });
      log_(new Date(e.t), e.on ? 'Світло з\'явилося' : 'Світло зникло', duration, label);
      if (Date.now() - e.t > CFG.SIGNAL_FRESH_MIN * 60000) return; // застаріла подія — без розсилки
      let ctx = '';
      try { ctx = zoneText_(e.on); } catch (err) { console.error('zone: ' + err); }
      const time = hhmm_(new Date(e.t));
      broadcast_((e.on
        ? '💡 Світло <b>увімкнули</b> о <b>' + time + '</b>, світла не було <b>' + duration + '</b>'
        : '🌑 Світло <b>вимкнули</b> о <b>' + time + '</b>, світло було <b>' + duration + '</b>') + ctx +
        (e.on ? '' : '\n\n🛗 Якщо ви застрягли в ліфті — натисніть «🆘 Застряг у ліфті» або /sos'));
    });
  } catch (e) {
    console.error(e);
  } finally {
    lock.releaseLock();
    if (fromCf) cfUsage_(); else usage_(t0);
  }
}

// Лічильник перевірок, запущених Cloudflare (для /usage)
function cfUsage_() {
  const p = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
  let c = JSON.parse(p.getProperty('CF_USAGE') || 'null');
  if (!c || c.d !== day) c = { d: day, n: 0 };
  c.n++;
  p.setProperty('CF_USAGE', JSON.stringify(c));
}

// Інтервал перевірки: щохвилини, але якщо денний ліміт Google під загрозою — рідше (автоматично)
function checkEvery_() {
  try {
    const u = JSON.parse(PropertiesService.getScriptProperties().getProperty('USAGE') || 'null');
    const now = new Date();
    if (!u || u.d !== Utilities.formatDate(now, CFG.TZ, 'dd.MM')) return CFG.CHECK_EVERY_MIN;
    const limit = CFG.DAILY_LIMIT_MIN * 60000;
    if (u.ms > limit * 0.75) return Math.max(3, CFG.SLOW_EVERY_MIN);
    const passed = Number(Utilities.formatDate(now, CFG.TZ, 'H')) * 60 + Number(Utilities.formatDate(now, CFG.TZ, 'm'));
    if (passed >= 30 && u.ms / passed * 1440 > limit * 0.85) return CFG.SLOW_EVERY_MIN;
  } catch (e) {}
  return CFG.CHECK_EVERY_MIN;
}

// ===== Облік часу роботи автоперевірок (ліміт Google на добу) =====
function usage_(t0) {
  try {
    const p = PropertiesService.getScriptProperties();
    const day = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
    let u = JSON.parse(p.getProperty('USAGE') || 'null');
    if (!u || u.d !== day) u = { d: day, ms: 0, n: 0, warned: false };
    u.ms += Date.now() - t0 + 300; // + запас на запуск
    u.n++;
    const limit = CFG.DAILY_LIMIT_MIN * 60000;
    if (!u.warned && u.ms > limit * 0.8) {
      u.warned = true;
      const admin = (p.getProperty('TG_ADMIN_ID') || '').trim();
      if (admin) send_(admin, '⚠️ Автоперевірки сьогодні вже працювали <b>' + fmtDur_(u.ms) + '</b> із ' + CFG.DAILY_LIMIT_MIN +
        ' хв ліміту Google. Якщо ліміт закінчиться — перевірки зупиняться до кінця доби.\n\n' +
        'Щоб зменшити навантаження, збільште CHECK_EVERY_MIN у коді й запустіть setup.');
    }
    p.setProperty('USAGE', JSON.stringify(u));
  } catch (e) { console.error('usage: ' + e); }
}

function cfTickText_() {
  const p = PropertiesService.getScriptProperties();
  const tick = Number(p.getProperty('CF_TICK') || 0);
  const c = JSON.parse(p.getProperty('CF_USAGE') || 'null');
  const n = c && c.d === Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM') ? c.n : 0;
  if (Date.now() - tick < CF.TICK_FRESH_MS)
    return '⏱ Перевірки запускає <b>Cloudflare</b> щохвилини ✅ (сьогодні: ' + n + ') — ліміт Google не витрачається';
  return '⏱ Перевірки запускає таймер Google' + (tick ? ' (від Cloudflare сигналу немає з ' + hhmm_(new Date(tick)) + ')' : '');
}

function fetchText_() {
  const c = JSON.parse(PropertiesService.getScriptProperties().getProperty('FETCH') || 'null');
  const n = c && c.d === Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM') ? c.n : 0;
  return '📨 Запитів на розсилки сьогодні: <b>' + n + '</b> (ліміт Google ~20 000 на всі запити)\n' +
    '☁️ Розсилка через Cloudflare: ' + (cfReady_() ? '<b>увімкнена</b> ✅' : '<b>вимкнена</b>');
}

function usageText_() {
  const u = JSON.parse(PropertiesService.getScriptProperties().getProperty('USAGE') || 'null');
  const day = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
  if (!u || u.d !== day) return '📈 <b>Навантаження сьогодні</b>\n\nТаймер Google сьогодні не працював — ліміт не витрачено ✅\n\n' +
    cfTickText_() + '\n' + fetchText_();
  const now = new Date();
  const passed = Number(Utilities.formatDate(now, CFG.TZ, 'H')) * 60 + Number(Utilities.formatDate(now, CFG.TZ, 'm'));
  const forecast = passed > 30 ? u.ms / passed * 1440 : 0;
  const pct = x => Math.round(x / (CFG.DAILY_LIMIT_MIN * 60000) * 100) + '%';
  return '📈 <b>Навантаження сьогодні</b>\n\n' +
    'Повних перевірок: <b>' + u.n + '</b> (зараз раз на ' + checkEvery_() + ' хв' +
      (checkEvery_() > CFG.CHECK_EVERY_MIN ? ' — економний режим' : '') + ')\n' +
    'Час роботи: <b>' + fmtDur_(u.ms) + '</b> із ' + CFG.DAILY_LIMIT_MIN + ' хв (' + pct(u.ms) + ')\n' +
    (forecast ? 'Прогноз на добу: ~<b>' + fmtDur_(forecast) + '</b> (' + pct(forecast) + ')' +
      (forecast > CFG.DAILY_LIMIT_MIN * 60000 * 0.9 ? ' ⚠️ ризиковано' : ' ✅') : '') +
    '\n\n' + cfTickText_() + '\n' + fetchText_() +
    '\n\n<i>Відповіді на кнопки в ліміт часу не входять.</i>';
}

// ===== Бот: обробка команд (/start, /stop, /status, /id, /post) =====
function pollBot_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('WEBHOOK') === '1') return; // повідомлення приходять миттєво через doPost
  const offset = Number(p.getProperty('TG_OFFSET') || 0);
  const r = JSON.parse(UrlFetchApp.fetch(tgUrl_('getUpdates') + '?timeout=0&offset=' + offset,
    { muteHttpExceptions: true }).getContentText());
  if (!r.ok) throw new Error(r.description);
  if (!r.result.length) return;
  // одразу підтверджуємо отримання, щоб паралельний запуск не обробив ці ж повідомлення
  const next = r.result[r.result.length - 1].update_id + 1;
  p.setProperty('TG_OFFSET', String(next));
  UrlFetchApp.fetch(tgUrl_('getUpdates') + '?timeout=0&limit=1&offset=' + next, { muteHttpExceptions: true });
  r.result.forEach(handleUpdate_);
}

// ===== Миттєві відповіді: Telegram сам надсилає повідомлення сюди (вебхук) =====
function doPost(e) {
  try {
    const u = JSON.parse(e.postData.contents);
    if (u.cf_click !== undefined) { // перехід за посиланням (Cloudflare уже перевірив підпис)
      const k = (PropertiesService.getScriptProperties().getProperty('CF_KEY') || '').trim();
      if (k && u.cf_click === k) recordClick_(u.slug, u.v);
      return ContentService.createTextOutput('ok');
    }
    if (u.cf_tick !== undefined) { // щохвилинний сигнал від Cloudflare Worker
      const k = (PropertiesService.getScriptProperties().getProperty('CF_KEY') || '').trim();
      if (k && u.cf_tick === k) {
        PropertiesService.getScriptProperties().setProperty('CF_TICK', String(Date.now()));
        runCheck_(true);
      }
      return ContentService.createTextOutput('ok');
    }
    const cache = CacheService.getScriptCache();
    const key = 'u' + u.update_id;
    if (!cache.get(key)) { // Telegram може повторити запит — не відповідаємо двічі
      cache.put(key, '1', 21600);
      try { handleUpdate_(u); }
      catch (err) { cache.remove(key); throw err; } // не вдалося — дозволяємо повтор
    }
  } catch (err) { console.error('doPost: ' + err); }
  return ContentService.createTextOutput('ok');
}

// Увімкнути миттєві відповіді (спершу розгорніть веб-застосунок і впишіть його адресу у WEBAPP_URL)
function connectWebhook() {
  const p = PropertiesService.getScriptProperties();
  // PROXY_URL — адреса посередника Cloudflare Worker (рекомендовано), інакше WEBAPP_URL
  const url = (p.getProperty('PROXY_URL') || p.getProperty('WEBAPP_URL') || '').trim();
  if (!/^https:\/\//.test(url))
    throw new Error('Впишіть у властивість PROXY_URL адресу посередника (…workers.dev)');
  const r = JSON.parse(UrlFetchApp.fetch(tgUrl_('setWebhook') + '?url=' + encodeURIComponent(url),
    { muteHttpExceptions: true }).getContentText());
  if (!r.ok) throw new Error(r.description);
  p.setProperty('WEBHOOK', '1');
  setCommands_();
  console.log('Готово: бот відповідає миттєво.');
}

// Повернутися до перевірки щохвилини
function disconnectWebhook() {
  UrlFetchApp.fetch(tgUrl_('deleteWebhook'), { muteHttpExceptions: true });
  PropertiesService.getScriptProperties().deleteProperty('WEBHOOK');
  console.log('Вебхук вимкнено: бот перевіряє повідомлення щохвилини.');
}

function handleUpdate_(u) {
  const p = PropertiesService.getScriptProperties();
  if (u.callback_query) {
    const d = u.callback_query.data || '';
    if (String(u.callback_query.from.id) !== (p.getProperty('TG_ADMIN_ID') || '').trim()) touchUser_(String(u.callback_query.from.id));
    return /^p/.test(d) ? prefCallback_(u.callback_query) : /^f/.test(d) ? fbCallback_(u.callback_query)
      : /^u/.test(d) ? undoCallback_(u.callback_query) : sosCallback_(u.callback_query);
  }
  const m = u.message;
  if (!m || m.chat.type !== 'private') return;
  const id = String(m.chat.id);
  const isAdmin = id === (p.getProperty('TG_ADMIN_ID') || '').trim();
  // адмін відповідає на звернення: Reply на повідомлення від бота
  if (isAdmin && m.reply_to_message && !/^\/post\b/i.test(m.caption || m.text || '') && fbReply_(m)) return;
  // оголошення з фото: адмін надсилає фото з підписом «/post текст»
  if (m.photo && isAdmin && /^\/post\b/i.test(m.caption || '')) {
    const cap = (m.caption || '').replace(/^\/post(@\S+)?\s*/i, '');
    const n = broadcastPhoto_(m.photo[m.photo.length - 1].file_id,
      cap ? '📢 ' + linkify_(esc_(cap), 'post-' + Utilities.formatDate(new Date(), CFG.TZ, 'ddMM-HHmm')) : '');
    return send_(id, '✅ Фото розіслано: ' + n + ' підписникам.', false, keyboardFor_(id));
  }
  // режим «Написати нам»: наступне повідомлення (текст, фото, голос…) іде адміну
  const btnPlain = (m.text || '').toLowerCase().replace(/[^\p{L}]/gu, '');
  if (CacheService.getScriptCache().get('fb_' + id) && !/^\//.test(m.text || '') && !BUTTONS[btnPlain]) return fbSend_(m);
  if (!m.text) return;
  const text = m.text.trim();
  // команда або натиснута кнопка: '/next', '⏭ Наступне' → 'next'
  const word = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const plain = text.toLowerCase().replace(/[^\p{L}]/gu, '');
  const cmd = word.startsWith('/') ? word.slice(1)
    : BUTTONS[plain] || '';
  CacheService.getScriptCache().remove('fb_' + id); // будь-яка команда/кнопка скасовує режим «Написати нам»
  if (!isAdmin) { statButton_(cmd); if (cmd !== 'stop') touchUser_(id); }
  const reply = msg => send_(id, msg, false, keyboardFor_(id));
  const adminOnly = () => { if (!isAdmin) reply('⛔ Ця команда лише для адміністратора.'); return isAdmin; };

  if (cmd === 'start') {
    addSub_(m.chat);
    if (!isAdmin) touchUser_(id); // позначаємо активність уже після підписки
    reply('👋 Ви підписалися на сповіщення про світло в <b>' + esc_(CFG.NAME) + '</b>.\n\n' + statusText_() +
      '\n\n🏠 Вкажіть свій будинок і підʼїзд у «⚙️ Налаштування» — тоді кнопка 🆘 «Застряг у ліфті» одразу знатиме, де ви.' +
      '\n\n<i>Дані про світло — від ' + esc_(CFG.SIGNAL_LABEL) + '.</i>\nКористуйтеся кнопками внизу 👇');
  } else if (cmd === 'sos') {
    sosStart_(m.chat);
  } else if (cmd === 'lift') {
    sosContact_(id);
  } else if (cmd === 'write') {
    fbStart_(id);
  } else if (cmd === 'reply') {
    if (!adminOnly()) return;
    const mm = text.match(/^\/reply(?:@\S+)?\s+(\d+)\s+([\s\S]+)/);
    if (!mm) return reply('Напишіть так: /reply ID текст відповіді\n(або просто зробіть Reply на звернення)');
    reply(fbAnswer_(mm[1], mm[2]) ? '✅ Відповідь надіслано.' : '⚠️ Не вдалося доставити — можливо, людина заблокувала бота.');
  } else if (cmd === 'settings') {
    const st = settingsView_(id);
    if (!st) return reply('Спершу підпишіться на бота — /start');
    send_(id, st.text, false, st.kb);
  } else if (cmd === 'sos_off' || cmd === 'sos_on') {
    if (!setPref_(id, { mode: cmd === 'sos_off' ? 'off' : 'all' })) return reply('Спершу підпишіться на бота — /start');
    reply(cmd === 'sos_off' ? '🔕 Тривоги «Застряг у ліфті» вимкнено. Увімкнути знову — /sos_on або ⚙️ Налаштування.'
      : '🔔 Тривоги «Застряг у ліфті» увімкнено для всіх будинків.');
  } else if (cmd === 'stop') {
    removeSub_(id);
    send_(id, '🔕 Ви відписалися. Щоб повернутися — /start', false, { remove_keyboard: true });
  } else if (cmd === 'status' || cmd === 'статус') {
    reply(statusText_() + footer_());
  } else if (cmd === 'grafik' || cmd === 'графік') {
    reply(lastSchedText_() + footer_());
  } else if (cmd === 'next') {
    reply(nextText_() + footer_());
  } else if (cmd === 'stats') {
    reply(statsText_() + footer_());
  } else if (cmd === 'id') {
    reply('Ваш ID: <code>' + id + '</code>');
  } else if (cmd === 'post') {
    if (!adminOnly()) return;
    const msg = text.replace(/^\/post(@\S+)?\s*/i, '');
    if (!msg) return reply('Напишіть так: /post Текст оголошення\nАбо надішліть фото з підписом «/post текст».');
    const slug = 'post-' + Utilities.formatDate(new Date(), CFG.TZ, 'ddMM-HHmm');
    const n = broadcast_('📢 ' + linkify_(esc_(msg), slug));
    reply('✅ Розіслано: ' + n + ' підписникам.' + (/\]\(https?:/.test(msg) ? '\n🔗 Переходи за посиланнями — /clicks (мітка ' + slug + ')' : ''));
  } else if (cmd === 'poll') {
    if (!adminOnly()) return;
    // /poll Питання | Варіант 1 | Варіант 2 | …
    const parts = text.replace(/^\/poll(@\S+)?\s*/i, '').split('|').map(x => x.trim()).filter(Boolean);
    if (parts.length < 3) return reply('Напишіть так:\n/poll Питання | Варіант 1 | Варіант 2\n(від 2 до 10 варіантів)');
    const n = broadcastPoll_(id, parts[0], parts.slice(1, 11));
    reply(n < 0 ? '⚠️ Не вдалося створити опитування.' : '✅ Опитування розіслано: ' + n + ' підписникам. Результати — у вашому опитуванні вище.');
  } else if (cmd === 'usage') {
    if (!adminOnly()) return;
    reply(usageText_());
  } else if (cmd === 'subs') {
    if (!adminOnly()) return;
    reply(subsText_());
  } else if (cmd === 'report') {
    if (!adminOnly()) return;
    morningReport_(new Date(), true);
  } else if (cmd === 'set' || cmd === 'get') {
    // властивостей понад 50 — у налаштуваннях Apps Script вони лише для читання, тому змінюємо через бота
    if (!adminOnly()) return;
    const EDITABLE = ['DONATE_TEXT', 'DONATE_URL', 'LIFT_PHONE', 'SOS_CHAT_ID', 'BROADCAST_VIA_CF', 'TG_CHAT_ID'];
    const mm = text.match(/^\/(?:set|get)(?:@\S+)?\s*([A-Z_]*)\s*([\s\S]*)$/i);
    const key = (mm && mm[1] || '').toUpperCase(), val = (mm && mm[2] || '').trim();
    if (cmd === 'get' || !key) {
      return reply('⚙️ <b>Налаштування бота</b>\n\n' + EDITABLE.map(k => '<code>' + k + '</code> = ' +
        esc_(p.getProperty(k) || '—')).join('\n') + '\n\nЗмінити: /set НАЗВА значення\nНапр.: /set DONATE_TEXT 💙 Підтримати бот\nВидалити: /set НАЗВА -');
    }
    if (EDITABLE.indexOf(key) < 0) return reply('⛔ Через бота можна змінювати лише: ' + EDITABLE.join(', '));
    if (!val || val === '-') { p.deleteProperty(key); return reply('🗑 ' + key + ' видалено.'); }
    p.setProperty(key, val);
    reply('✅ ' + key + ' = ' + esc_(val) + (key.indexOf('DONATE') === 0 ? '\n\nТак виглядає підпис:' + footer_() : ''));
  } else if (cmd === 'activity') {
    if (!adminOnly()) return;
    try { statCleanup_(); } catch (e) {}
    reply(activityText_());
  } else if (cmd === 'clicks') {
    if (!adminOnly()) return;
    reply(clicksText_());
  } else if (cmd === 'link') {
    if (!adminOnly()) return;
    const mm = text.match(/^\/link(?:@\S+)?\s+(\S+)\s+(https?:\/\/\S+)/i);
    if (!mm) return reply('Напишіть так: /link назва https://посилання\nНазва — латиницею, напр. kava-misto');
    const url = trackUrl_(mm[1], mm[2]);
    reply(url === mm[2] ? '⚠️ Не задано PROXY_URL або CF_KEY — лічильник не працює.'
      : '🔗 Посилання з лічильником (мітка <b>' + esc_(mm[1].toLowerCase().replace(/[^a-z0-9-]/g, '')) + '</b>):\n<code>' + esc_(url) + '</code>\n\nПереходи — /clicks');
  } else if (cmd === 'ad') {
    if (!adminOnly()) return;
    const arg = text.replace(/^\/ad(@\S+)?\s*/i, '').trim();
    if (/^(off|вимк)/i.test(arg)) { p.deleteProperty('AD_FOOTER'); return reply('📣 Рекламу в підписі вимкнено.'); }
    const mm = arg.match(/^(.+?)\s*\|\s*(https?:\/\/\S+)(?:\s*\|\s*([a-z0-9-]+))?$/i);
    if (!mm) {
      const cur = JSON.parse(p.getProperty('AD_FOOTER') || 'null');
      return reply('📣 <b>Реклама в підписі</b> (під сповіщеннями й відповідями бота)\n\n' +
        (cur ? 'Зараз: «' + esc_(cur.text) + '» → ' + esc_(cur.url) + ' (мітка ' + cur.slug + ')\n\n' : 'Зараз вимкнено.\n\n') +
        'Увімкнути: /ad Текст | https://посилання | мітка\nНапр.: /ad Кава «Ранок» −10% сусідам | https://instagram.com/ranok | ranok\nВимкнути: /ad off');
    }
    const ad = { text: mm[1].trim().slice(0, 80), url: mm[2], slug: (mm[3] || 'ad-' + Utilities.formatDate(new Date(), CFG.TZ, 'ddMM')).toLowerCase() };
    p.setProperty('AD_FOOTER', JSON.stringify(ad));
    reply('✅ Рекламу ввімкнено. Так виглядатиме підпис:' + footer_() + '\n\nПереходи — /clicks (мітка ' + ad.slug + ')');
  } else if (cmd === 'undo') {
    if (!adminOnly()) return;
    undoMenu_(id);
  } else if (cmd === 'cftest') {
    if (!adminOnly()) return;
    reply(cfTestText_(id));
  } else if (cmd === 'sosban' || cmd === 'sosunban') {
    if (!adminOnly()) return;
    const mm = text.match(/(\d{5,})/);
    if (!mm) return reply('Напишіть так: /' + cmd + ' ID (ID є в повідомленнях про тривогу та в аркуші «SOS»)');
    sosBan_(mm[1], cmd === 'sosban');
    reply(cmd === 'sosban' ? '🚫 Тривоги від ' + mm[1] + ' заблоковано.' : '✅ ' + mm[1] + ': блокування й позначку хибних тривог знято.');
  } else if (cmd === 'sostest') {
    if (!adminOnly()) return;
    sosStart_(m.chat, true);
  } else if (cmd === 'admin') {
    if (!adminOnly()) return;
    reply('🛠 <b>Команди адміністратора</b>\n\n' +
      '/post текст — розіслати оголошення всім\n' +
      'Фото з підписом «/post текст» — розіслати фото\n' +
      '/subs — підписники\n' +
      '/usage — навантаження та ліміт Google\n' +
      '/poll Питання | Варіант 1 | Варіант 2 — опитування для всіх\n' +
      '/report — надіслати ранкове повідомлення зараз (лише вам)\n' +
      '/sostest — перевірити кнопку 🆘 (тривога лише вам)\n' +
      '/sosban ID, /sosunban ID — заблокувати / розблокувати тривоги від людини\n' +
      '/cftest — перевірити розсилку через Cloudflare\n' +
      '/undo — видалити помилкову розсилку в усіх (до 48 год)\n' +
      '/ad Текст | https://… | мітка — реклама в підписі (/ad off — вимкнути)\n' +
      '/link назва https://… — посилання з лічильником\n' +
      '/clicks — переходи за посиланнями\n' +
      '/activity — активність: кнопки, активні сусіди, доставлені повідомлення\n' +
      '/get — налаштування; /set НАЗВА значення — змінити (напр. /set DONATE_TEXT 💙 Підтримати бот)\n' +
      'У /post можна писати посилання так: [текст](https://…) — переходи теж рахуються\n' +
      'Відповісти на звернення — Reply на нього або /reply ID текст\n' +
      '/id — ваш ID');
  } else {
    reply(statusText_() + '\n\nКористуйтеся кнопками внизу 👇\n✉️ Щоб написати нам — натисніть «Написати нам».');
  }
}

// Кнопки внизу чату
// Текст кнопок (без емодзі й пробілів) → команда
const BUTTONS = { 'статус': 'status', 'наступне': 'next', 'графік': 'grafik', 'статистика': 'stats', 'підписники': 'subs',
  'застрягуліфті': 'sos', 'налаштування': 'settings', 'написатинам': 'write' };

const KEYBOARD = {
  keyboard: [[{ text: '💡 Статус' }, { text: '⏭ Наступне' }], [{ text: '🗓 Графік' }, { text: '📊 Статистика' }],
    [{ text: '🆘 Застряг у ліфті' }, { text: '⚙️ Налаштування' }], [{ text: '✉️ Написати нам' }]],
  resize_keyboard: true, is_persistent: true,
};

// Меню команд у Telegram (кнопка «Меню» біля поля вводу) — викликається з setup/connectWebhook
function setCommands_() {
  UrlFetchApp.fetch(tgUrl_('setMyCommands'), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ commands: [
      { command: 'status', description: 'Чи є зараз світло' },
      { command: 'next', description: 'Наступне вимкнення/увімкнення за графіком' },
      { command: 'grafik', description: 'Графік відключень групи ' + SCHED.GROUP },
      { command: 'stats', description: 'Статистика відключень' },
      { command: 'sos', description: '🆘 Застряг у ліфті' },
      { command: 'lift', description: 'Зберегти номер аварійки ліфтів' },
      { command: 'settings', description: '⚙️ Налаштування тривог' },
      { command: 'write', description: '✉️ Написати нам' },
      { command: 'stop', description: 'Відписатися' },
    ] }),
  });
  const admin = (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim();
  if (admin) UrlFetchApp.fetch(tgUrl_('setMyCommands'), { // окреме меню лише для адміна
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ scope: { type: 'chat', chat_id: Number(admin) }, commands: [
      { command: 'status', description: 'Чи є зараз світло' },
      { command: 'next', description: 'Наступне вимкнення/увімкнення' },
      { command: 'grafik', description: 'Графік відключень' },
      { command: 'stats', description: 'Статистика відключень' },
      { command: 'post', description: '👑 Розіслати оголошення' },
      { command: 'subs', description: '👑 Підписники' },
      { command: 'usage', description: '👑 Навантаження та ліміт' },
      { command: 'poll', description: '👑 Опитування для всіх' },
      { command: 'undo', description: '👑 Видалити помилкову розсилку' },
      { command: 'clicks', description: '👑 Переходи за посиланнями' },
      { command: 'activity', description: '👑 Активність і охоплення' },
      { command: 'ad', description: '👑 Реклама в підписі' },
      { command: 'report', description: '👑 Ранкове повідомлення зараз (лише мені)' },
      { command: 'sos', description: '🆘 Застряг у ліфті' },
      { command: 'admin', description: '👑 Усі команди адміна' },
    ] }),
  });
}

function keyboardFor_(id) {
  const admin = (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim();
  if (id !== admin) return KEYBOARD;
  return Object.assign({}, KEYBOARD, { keyboard: KEYBOARD.keyboard.concat([[{ text: '👥 Підписники' }]]) });
}

function subsText_() {
  const sh = subsSheet_();
  const n = Math.max(0, sh.getLastRow() - 1);
  if (!n) return '👥 Підписників поки немає.';
  const rows = sh.getRange(2, 1, n, 4).getValues();
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const last = rows.slice(-5).reverse().map(r => '• ' + esc_(r[1] || 'без імені') + (r[2] ? ' ' + esc_(r[2]) : '') +
    ' — ' + (r[3] instanceof Date ? Utilities.formatDate(r[3], tz, 'dd.MM HH:mm') : esc_(r[3])));
  return '👥 Підписників: <b>' + n + '</b>\n\nОстанні:\n' + last.join('\n');
}

function broadcastPhoto_(fileId, caption) {
  const admin = (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim();
  const base = { photo: fileId, caption: caption + footer_(), parse_mode: 'HTML', disable_notification: isNight_() };
  // заодно оновлюємо кнопки внизу (🆘, ⚙️, ✉️); адміну — окремо, з його кнопкою «Підписники»
  const r = massSend_(subs_().filter(x => x !== admin), 'sendPhoto', Object.assign({ reply_markup: KEYBOARD }, base));
  recordBroadcast_('Фото', caption || '(без підпису)', r);
  statDelivered_('📢 Оголошення', r.n);
  if (admin && subs_().indexOf(admin) >= 0 &&
      tgCall_('sendPhoto', Object.assign({ chat_id: admin, reply_markup: keyboardFor_(admin) }, base)).ok) r.n++;
  return r.n;
}

function statusText_() {
  const p = PropertiesService.getScriptProperties();
  const st = p.getProperty('STATE');
  if (!st) return 'Стан ще невідомий, спробуйте за хвилину.';
  const since = Number(p.getProperty('SINCE'));
  const sameDay = Utilities.formatDate(new Date(since), CFG.TZ, 'dd.MM') === Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
  const at = (sameDay ? '' : Utilities.formatDate(new Date(since), CFG.TZ, 'dd.MM') + ' ') + hhmm_(new Date(since));
  return (st === 'ON' ? '💡 Світло <b>є</b> з ' + at : '🌑 Світла <b>немає</b> з ' + at) +
    ' (вже <b>' + fmtDur_(Date.now() - since) + '</b>)';
}

// ===== Розсилка =====
function broadcast_(html) {
  const text = html + footer_();
  const silent = isNight_() ? 'true' : 'false';
  const r = massSend_(subs_(), 'sendMessage',
    { text: text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: silent === 'true' });
  recordBroadcast_('Повідомлення', html, r);
  statDelivered_(catOf_(html), r.n);
  const n = r.n;
  const extra = PropertiesService.getScriptProperties().getProperty('TG_CHAT_ID');
  if (extra) send_(extra.trim(), text, isNight_());
  return n;
}

// ===== Масова розсилка: через Cloudflare Worker (економить ліміт Google) або напряму =====
// base — однакові для всіх поля запиту Telegram (без chat_id). Повертає { n: доставлено, blocked: [...] }.
const CF = { CHUNK: 40, TICK_FRESH_MS: 150000 }; // TICK_FRESH_MS: якщо від Cloudflare нічого 2,5 хв — перевіряє Google // скільки отримувачів за один виклик Worker'а (безкоштовний план — до 50 запитів)

function cfReady_() {
  const p = PropertiesService.getScriptProperties();
  return p.getProperty('BROADCAST_VIA_CF') === '1' && !!(p.getProperty('PROXY_URL') || '').trim() && !!(p.getProperty('CF_KEY') || '').trim();
}

// Один виклик Worker'а: повертає [{id, code}] або null, якщо Worker недоступний
function cfCall_(ids, method, base, extra) {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty('PROXY_URL') || '').trim().replace(/\/+$/, '') + '/send';
  try {
    const r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ key: p.getProperty('CF_KEY').trim(), token: prop_('TG_TOKEN'), method: method, ids: ids, payload: base,
        items: extra ? ids.map(id => Object.assign({ chat_id: id }, extra[id] || {})) : undefined }) });
    countFetch_(1);
    if (r.getResponseCode() !== 200) { console.error('Cloudflare ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200)); return null; }
    const j = JSON.parse(r.getContentText());
    return j && j.results ? j.results : null;
  } catch (e) { console.error('Cloudflare: ' + e); return null; }
}

// extra — необовʼязково: {chatId: {поля лише для цього отримувача}} (напр. message_id для видалення)
function massSend_(ids, method, base, extra) {
  const out = { n: 0, blocked: [], sent: [] }; // sent: [[chatId, message_id]] — щоб потім можна було видалити
  ids = ids.filter(Boolean);
  if (!ids.length) return out;
  let direct = ids;
  if (cfReady_()) {
    direct = [];
    for (let i = 0; i < ids.length; i += CF.CHUNK) {
      const chunk = ids.slice(i, i + CF.CHUNK);
      const res = cfCall_(chunk, method, base, extra);
      if (!res) { direct = direct.concat(chunk); continue; } // Worker недоступний — ця пачка піде напряму
      const byId = {};
      const mids = {};
      res.forEach(x => { byId[String(x.id)] = x.code; mids[String(x.id)] = x.mid; });
      chunk.forEach(id => {
        const c = byId[id];
        if (c === 200) { out.n++; if (mids[id]) out.sent.push([id, mids[id]]); }
        else if (c === 403) out.blocked.push(id);
        else if (c === 400) console.error('Telegram 400 для ' + id);
        else direct.push(id); // 429 / збій мережі — дошлемо напряму
      });
    }
    if (direct.length) console.log('Cloudflare: дошлемо напряму ' + direct.length);
  }
  // напряму з Google: пачками по 25 паралельно (~30 повідомлень/с — ліміт Telegram)
  for (let i = 0; i < direct.length; i += 25) {
    const batch = direct.slice(i, i + 25);
    const res = UrlFetchApp.fetchAll(batch.map(id => ({
      url: tgUrl_(method), method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify(Object.assign({ chat_id: id }, base, extra ? extra[id] : {})),
    })));
    countFetch_(batch.length);
    res.forEach((r, j) => {
      const c = r.getResponseCode();
      if (c === 200) {
        out.n++;
        try { const mid = JSON.parse(r.getContentText()).result.message_id; if (mid) out.sent.push([batch[j], mid]); } catch (e) {}
      }
      else if (c === 403) out.blocked.push(batch[j]); // користувач заблокував бота
      else console.error('Telegram ' + batch[j] + ': ' + r.getContentText());
    });
    if (i + 25 < direct.length) Utilities.sleep(1000);
  }
  if (method !== 'deleteMessage') out.blocked.forEach(removeSub_);
  return out;
}

// ===== Статистика: кнопки, активні користувачі, доставлені повідомлення (/activity) =====
// Telegram не показує ботам перегляди повідомлень — тому рахуємо «доставлено» (≈ охоплення).
const STAT_LABELS = { status: '💡 Статус', next: '⏭ Наступне', grafik: '🗓 Графік', stats: '📊 Статистика',
  sos: '🆘 Застряг у ліфті', settings: '⚙️ Налаштування', write: '✉️ Написати нам', lift: '📇 Номер аварійки',
  start: '▶️ Старт', stop: '🔕 Відписалися' };

function catOf_(html) {
  if (/Світло <b>(увімкнули|вимкнули)/.test(html)) return '💡 Світло є / немає';
  if (/за графіком <b>(вимикатимуть|вмикатимуть)/.test(html)) return '⏰ Нагадування';
  if (/^(🔄 <b>Оновлено<\/b> графік|🗓 Графік)/.test(html)) return '🗓 Графіки';
  if (/Доброго ранку/.test(html)) return '🌅 Ранковий звіт';
  if (/напруг/i.test(html)) return '⚠️ Напруга';
  if (/^📢/.test(html)) return '📢 Оголошення';
  return '📨 Інше';
}

function statKey_(d) { return 'ST_' + Utilities.formatDate(d || new Date(), CFG.TZ, 'yyyyMMdd'); }

function statUpdate_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    const p = PropertiesService.getScriptProperties(), k = statKey_();
    const st = JSON.parse(p.getProperty(k) || '{"b":{},"d":{}}');
    fn(st);
    p.setProperty(k, JSON.stringify(st));
  } catch (e) { console.error('stat: ' + e); } finally { lock.releaseLock(); }
}

function statButton_(cmd) {
  if (!STAT_LABELS[cmd]) return;
  statUpdate_(st => { st.b[cmd] = (st.b[cmd] || 0) + 1; });
}

function statDelivered_(cat, n) {
  if (!n) return;
  statUpdate_(st => { const x = st.d[cat] = st.d[cat] || [0, 0]; x[0]++; x[1] += n; });
}

// Остання активність підписника (колонка H) — не частіше разу на 6 год на людину
function touchUser_(id) {
  try {
    const cache = CacheService.getScriptCache(), ck = 'act_' + id;
    const day = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    if (cache.get(ck) === day) return;
    const me = getPref_(id);
    if (!me) return; // ще не підписаний (напр. щойно натиснув «Старт») — позначимо після підписки
    const sh = subsSheet_();
    if (sh.getRange('H1').getValue() === '') sh.getRange('H1').setValue('Остання активність').setFontWeight('bold');
    sh.getRange(me.row, 8).setValue("'" + day);
    cache.put(ck, day, 21600); // запам'ятовуємо лише після запису і лише на цю добу
  } catch (e) { console.error('touch: ' + e); }
}

function activityText_() {
  const p = PropertiesService.getScriptProperties();
  const days = [];
  for (let i = 0; i < 7; i++) days.push(JSON.parse(p.getProperty(statKey_(new Date(Date.now() - i * 864e5))) || '{"b":{},"d":{}}'));
  const sum = (sel) => { const o = {}; days.forEach(st => Object.keys(sel(st)).forEach(k => {
    const v = sel(st)[k]; o[k] = Array.isArray(v) ? [(o[k] || [0, 0])[0] + v[0], (o[k] || [0, 0])[1] + v[1]] : (o[k] || 0) + v; })); return o; };
  const bToday = days[0].b, bWeek = sum(st => st.b), dToday = days[0].d, dWeek = sum(st => st.d);

  // активні користувачі з колонки H
  const sh = subsSheet_();
  const n = Math.max(0, sh.getLastRow() - 1);
  const act = n ? sh.getRange(2, 8, n, 1).getValues().map(r => r[0] instanceof Date ? Utilities.formatDate(r[0], CFG.TZ, 'yyyy-MM-dd') : String(r[0])) : [];
  const dstr = i => Utilities.formatDate(new Date(Date.now() - i * 864e5), CFG.TZ, 'yyyy-MM-dd');
  const today = dstr(0), d7 = dstr(6), d30 = dstr(29);
  const a1 = act.filter(x => x === today).length, a7 = act.filter(x => x && x >= d7).length, a30 = act.filter(x => x && x >= d30).length;

  let t = '📈 <b>Активність</b> (сьогодні · за 7 днів)\n\n' +
    '👥 Підписників: <b>' + n + '</b>\n' +
    '🙋 Активні (натискали кнопки): <b>' + a1 + '</b> · <b>' + a7 + '</b> · за 30 днів ' + a30 + '\n\n🔘 <b>Кнопки</b>\n';
  const bk = Object.keys(STAT_LABELS).filter(k => bWeek[k]);
  t += bk.length ? bk.sort((x, y) => bWeek[y] - bWeek[x]).map(k => STAT_LABELS[k] + ': ' + (bToday[k] || 0) + ' · ' + bWeek[k]).join('\n') : 'ще немає даних';
  t += '\n\n📨 <b>Доставлено повідомлень</b> (розсилок → отримали)\n';
  const dk = Object.keys(dWeek);
  t += dk.length ? dk.sort((x, y) => dWeek[y][1] - dWeek[x][1]).map(k => k + ': ' + (dToday[k] ? dToday[k][0] + ' → ' + dToday[k][1] : '0') +
    ' · ' + dWeek[k][0] + ' → ' + dWeek[k][1]).join('\n') : 'ще немає даних';
  return t + '\n\n<i>Telegram не показує ботам перегляди, тому «отримали» = доставлено в чат (≈ охоплення). ' +
    'Активність рахується без вас (адміна).</i>';
}

// прибирання старої статистики (раз на добу з ранкового звіту не потрібне — викликається з /activity)
function statCleanup_() {
  const p = PropertiesService.getScriptProperties(), keep = statKey_(new Date(Date.now() - 40 * 864e5));
  Object.keys(p.getProperties()).forEach(k => { if (/^ST_\d{8}$/.test(k) && k < keep) p.deleteProperty(k); });
}

// ===== Журнал розсилок і видалення помилкових повідомлень (/undo) =====
const UNDO = { SHEET: 'Розсилки', KEEP: 30, HOURS: 47 }; // Telegram дозволяє видаляти повідомлення бота лише 48 год

function logSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(UNDO.SHEET);
  if (!sh) {
    sh = ss.insertSheet(UNDO.SHEET);
    sh.appendRow(['ID', 'Дата', 'Час', 'Тип', 'Текст', 'Отримувачів', 'Повідомлення (для видалення)']);
    sh.setFrozenRows(1);
    sh.getRange('A1:G1').setFontWeight('bold');
  }
  return sh;
}

function recordBroadcast_(type, preview, r) {
  try {
    if (!r || !r.sent || !r.sent.length) return '';
    const sh = logSheet_();
    const now = new Date();
    const plain = String(preview || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    sh.appendRow(["'" + now.getTime(), Utilities.formatDate(now, CFG.TZ, 'dd.MM.yyyy'), hhmm_(now), type, plain, r.sent.length,
      r.sent.map(x => x[0] + ':' + x[1]).join(',')]);
    const extra = sh.getLastRow() - 1 - UNDO.KEEP;
    if (extra > 0) sh.deleteRows(2, extra);
    return String(now.getTime());
  } catch (e) { console.error('Журнал розсилок: ' + e); return ''; }
}

// Видаляє розсилку з журналу в усіх отримувачів. Повертає {n, total} або null
function undoDeleteById_(logId) {
  const item = undoList_(true).find(x => x.id === String(logId));
  if (!item) return null;
  logSheet_().getRange(item.row, 7).setValue(''); // щоб не видалити двічі
  const extra = {}, ids = [];
  item.list.split(',').forEach(pair => { const [c, mid] = pair.split(':'); if (c && mid) { ids.push(c); extra[c] = { message_id: Number(mid) }; } });
  const r = massSend_(ids, 'deleteMessage', {}, extra);
  logSheet_().getRange(item.row, 4).setValue(item.type + ' — видалено');
  return { n: r.n, total: ids.length };
}

// останні розсилки, які ще можна видалити
function undoList_(all) {
  const sh = logSheet_();
  if (sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  return rows.map((r, i) => ({ id: String(r[0]), time: r[2] instanceof Date ? hhmm_(r[2]) : String(r[2]), date: r[1] instanceof Date ?
    Utilities.formatDate(r[1], CFG.TZ, 'dd.MM') : String(r[1]).slice(0, 5), type: String(r[3]), text: String(r[4]), n: Number(r[5]),
    list: String(r[6] || ''), row: i + 2 }))
    .filter(x => x.list && Date.now() - Number(x.id) < UNDO.HOURS * 3600e3).reverse().slice(0, all ? 1000 : 6);
}

function undoMenu_(id) {
  const list = undoList_();
  if (!list.length) return send_(id, '🗑 Немає розсилок, які можна видалити.\n<i>Telegram дозволяє видаляти повідомлення бота лише протягом 48 годин.</i>');
  send_(id, '🗑 <b>Яку розсилку видалити в усіх підписників?</b>\n\n' +
    list.map((x, i) => (i + 1) + '. ' + x.date + ' ' + x.time + ' · ' + esc_(x.type) + ' · ' + x.n + ' отр.\n<i>' + esc_(x.text.slice(0, 70)) + '</i>').join('\n\n'),
    false, { inline_keyboard: list.map((x, i) => [{ text: '🗑 ' + (i + 1) + '. ' + x.time + ' ' + x.text.slice(0, 25), callback_data: 'ux:' + x.id }])
      .concat([[{ text: 'Скасувати', callback_data: 'un:0' }]]) });
}

function undoCallback_(cq) {
  const uid = String(cq.from.id);
  const admin = (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim();
  const answer = t => tgCall_('answerCallbackQuery', { callback_query_id: cq.id, text: t || '' });
  if (uid !== admin) return answer('Лише для адміністратора');
  const chatId = cq.message.chat.id, msgId = cq.message.message_id;
  const edit = (text, kb) => tgCall_('editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text: text, reply_markup: kb });
  const m = (cq.data || '').match(/^u([xyn]):(\d+)$/);
  if (!m || m[1] === 'n') { answer(''); return edit('Скасовано.'); }
  const item = undoList_().find(x => x.id === m[2]);
  if (!item) { answer(''); return edit('⚠️ Цю розсилку вже видалено або минуло 48 годин.'); }
  if (m[1] === 'x') {
    answer('');
    return edit('🗑 Видалити в <b>' + item.n + '</b> підписників?\n\n' + item.date + ' ' + item.time + ' · ' + esc_(item.type) +
      '\n<i>' + esc_(item.text) + '</i>', { inline_keyboard: [[{ text: '✅ Так, видалити', callback_data: 'uy:' + item.id },
        { text: 'Скасувати', callback_data: 'un:0' }]] });
  }
  answer('Видаляю…');
  edit('⏳ Видаляю в ' + item.n + ' підписників…');
  const r = undoDeleteById_(item.id) || { n: 0, total: 0 };
  edit('✅ Видалено в <b>' + r.n + '</b> з ' + r.total + ' підписників.' +
    (r.n < r.total ? '\n<i>Решта, ймовірно, вже видалили повідомлення самі або заблокували бота.</i>' : ''));
}

// Лічильник запитів розсилок за добу (для /usage)
function countFetch_(k) {
  const p = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
  let c = JSON.parse(p.getProperty('FETCH') || 'null');
  if (!c || c.d !== day) c = { d: day, n: 0 };
  c.n += k;
  p.setProperty('FETCH', JSON.stringify(c));
}

// /cftest: перевірка розсилки через Cloudflare лише на адміна
function cfTestText_(admin) {
  const p = PropertiesService.getScriptProperties();
  if (!(p.getProperty('PROXY_URL') || '').trim()) return '⚠️ Не задано PROXY_URL.';
  if (!(p.getProperty('CF_KEY') || '').trim()) return '⚠️ Не задано CF_KEY у властивостях скрипта.';
  const res = cfCall_([admin], 'sendMessage', { text: '☁️ Тест: це повідомлення надіслав Cloudflare Worker.', parse_mode: 'HTML' });
  if (!res) return '❌ Worker не відповів або відхилив запит. Перевірте, що код Worker\'а оновлено, а SEND_KEY у Cloudflare = CF_KEY у скрипті (подробиці — у «Виконаннях»).';
  const c = (res[0] || {}).code;
  return c === 200 ? '✅ Cloudflare працює! Розсилка через нього зараз ' + (cfReady_() ? '<b>увімкнена</b>.' :
    '<b>вимкнена</b> — щоб увімкнути, додайте властивість BROADCAST_VIA_CF = 1.') : '⚠️ Worker відповів, але Telegram повернув код ' + c + '.';
}

function send_(chatId, html, silent, markup) {
  const r = UrlFetchApp.fetch(tgUrl_('sendMessage'), {
    method: 'post',
    payload: { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: 'true',
      disable_notification: silent ? 'true' : 'false',
      reply_markup: markup ? JSON.stringify(markup) : '' },
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) console.error('Telegram ' + chatId + ': ' + r.getContentText());
  return r.getResponseCode();
}

function tgUrl_(method) {
  return 'https://api.telegram.org/bot' + prop_('TG_TOKEN').trim() + '/' + method;
}

// ===== Підписники (лист «Підписники») =====
function subsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CFG.SUBS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CFG.SUBS_SHEET);
    sh.appendRow(['ID', 'Ім\'я', 'Username', 'Дата підписки', 'SOS-тривоги', 'Мій будинок']);
    sh.setFrozenRows(1);
    sh.getRange('A1:F1').setFontWeight('bold');
  } else if (sh.getRange('E1').getValue() === '') { // старі таблиці: додаємо колонки налаштувань
    sh.getRange('E1:G1').setValues([['SOS-тривоги', 'Мій будинок', 'Мій підʼїзд']]).setFontWeight('bold');
  }
  if (sh.getRange('G1').getValue() === '') sh.getRange('G1').setValue('Мій підʼїзд').setFontWeight('bold');
  return sh;
}

function subs_() {
  const sh = subsSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0])).filter(Boolean);
}

function addSub_(chat) {
  if (subs_().indexOf(String(chat.id)) >= 0) return;
  subsSheet_().appendRow(["'" + chat.id, [chat.first_name, chat.last_name].filter(Boolean).join(' '),
    chat.username ? '@' + chat.username : '', Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM.yyyy HH:mm')]);
}

function removeSub_(id) {
  const sh = subsSheet_();
  const ids = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(id)) sh.deleteRow(i + 2);
}

// ===== «Написати нам»: звернення сусідів адміну =====
const FB = { WAIT_SEC: 900, MAX_PER_HOUR: 5, SHEET: 'Звернення' };

function fbStart_(id) {
  CacheService.getScriptCache().put('fb_' + id, '1', FB.WAIT_SEC);
  send_(id, '✉️ <b>Напишіть нам</b>\n\nНадішліть одним повідомленням питання, пропозицію або проблему — можна з фото чи голосовим. ' +
    'Ми відповімо тут, у боті.', false, { inline_keyboard: [[{ text: '✖️ Скасувати', callback_data: 'fx:0' }]] });
}

function fbCallback_(cq) {
  const id = String(cq.from.id);
  tgCall_('answerCallbackQuery', { callback_query_id: cq.id, text: '' });
  const chatId = cq.message && cq.message.chat.id, msgId = cq.message && cq.message.message_id;
  if (cq.data === 'fx:0') {
    CacheService.getScriptCache().remove('fb_' + id);
    tgCall_('editMessageText', { chat_id: chatId, message_id: msgId, text: 'Скасовано.' });
  } else if (cq.data === 'fw:0') fbStart_(id);
}

function fbSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(FB.SHEET);
  if (!sh) {
    sh = ss.insertSheet(FB.SHEET);
    sh.appendRow(['Дата', 'Час', 'ID', 'Ім\'я', 'Username', 'Повідомлення', 'Відповідь']);
    sh.setFrozenRows(1);
    sh.getRange('A1:G1').setFontWeight('bold');
  }
  return sh;
}

// повідомлення адміна (message_id) → ID автора звернення
function fbMapPut_(msgIds, uid) {
  const p = PropertiesService.getScriptProperties();
  const map = JSON.parse(p.getProperty('FB_MAP') || '{}');
  msgIds.filter(Boolean).forEach(x => { map[x] = uid; });
  const keys = Object.keys(map);
  keys.slice(0, Math.max(0, keys.length - 300)).forEach(k => delete map[k]);
  p.setProperty('FB_MAP', JSON.stringify(map));
}

function fbSend_(m) {
  const id = String(m.chat.id);
  const cache = CacheService.getScriptCache();
  cache.remove('fb_' + id);
  const n = Number(cache.get('fbn_' + id) || 0);
  if (n >= FB.MAX_PER_HOUR) return send_(id, '⏳ Забагато повідомлень за годину. Спробуйте трохи пізніше.', false, keyboardFor_(id));
  cache.put('fbn_' + id, String(n + 1), 3600);

  const admin = (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim();
  const body = m.text || m.caption || '';
  const kind = m.photo ? '📷 фото' : m.voice ? '🎤 голосове' : m.video ? '🎬 відео' : m.document ? '📎 файл' : m.sticker ? 'стікер' : '';
  const r1 = tgCall_('sendMessage', { chat_id: admin, parse_mode: 'HTML', disable_web_page_preview: true,
    text: '✉️ <b>Звернення</b> від ' + userLink_(m.chat) + '\nID: <code>' + id + '</code>' +
      (body ? '\n\n' + esc_(body) : '') + (kind ? '\n\n<i>(' + kind + ' — нижче)</i>' : '') +
      '\n\n<i>↩️ Щоб відповісти — зробіть Reply на це повідомлення.</i>' });
  let r2 = null;
  if (!m.text) r2 = tgCall_('copyMessage', { chat_id: admin, from_chat_id: id, message_id: m.message_id });
  fbMapPut_([r1.ok && r1.result.message_id, r2 && r2.ok && r2.result.message_id], id);
  fbSheet_().appendRow([Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM.yyyy'), hhmm_(new Date()), "'" + id,
    [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' '), m.chat.username ? '@' + m.chat.username : '',
    (kind ? '[' + kind + '] ' : '') + body, '']);
  send_(id, r1.ok ? '✅ Дякуємо! Повідомлення надіслано. Відповідь прийде сюди, у бот.'
    : '⚠️ Не вдалося надіслати. Спробуйте пізніше.', false, keyboardFor_(id));
}

// Reply адміна на звернення → автору
function fbReply_(m) {
  const map = JSON.parse(PropertiesService.getScriptProperties().getProperty('FB_MAP') || '{}');
  const uid = map[m.reply_to_message.message_id];
  if (!uid) return false;
  const ok = m.text ? fbAnswer_(uid, m.text) : fbAnswer_(uid, m.caption || '', m.message_id);
  send_(String(m.chat.id), ok ? '✅ Відповідь надіслано.' : '⚠️ Не вдалося доставити — можливо, людина заблокувала бота.');
  return true;
}

function fbAnswer_(uid, text, copyMsgId) {
  const kb = { inline_keyboard: [[{ text: '✉️ Відповісти', callback_data: 'fw:0' }]] };
  let ok;
  if (copyMsgId) {
    const admin = (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim();
    send_(uid, '💬 <b>Відповідь від ' + esc_(CFG.NAME) + ':</b>');
    ok = tgCall_('copyMessage', { chat_id: uid, from_chat_id: admin, message_id: copyMsgId, reply_markup: kb }).ok;
  } else {
    ok = send_(uid, '💬 <b>Відповідь від ' + esc_(CFG.NAME) + ':</b>\n\n' + esc_(text), false, kb) === 200;
  }
  if (ok) { // записуємо відповідь у таблицю (останнє звернення цієї людини)
    const sh = fbSheet_();
    const ids = sh.getLastRow() < 2 ? [] : sh.getRange(2, 3, sh.getLastRow() - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(uid)) {
      const c = sh.getRange(i + 2, 7);
      c.setValue((c.getValue() ? c.getValue() + '\n' : '') + (text || '[медіа]'));
      break;
    }
  }
  return ok;
}

// ===== Налаштування підписника (колонки E/F таблиці «Підписники») =====
const PREF_MODES = { all: 'усі будинки', house: 'тільки мій будинок', off: 'вимкнено' };

// [{id, mode: 'all'|'house'|'off', house, row}]
function subsData_() {
  const sh = subsSheet_();
  if (sh.getLastRow() < 2) return [];
  const toMode = v => { v = String(v || '').toLowerCase(); return /вимк|off/.test(v) ? 'off' : /тільки|мій|house/.test(v) ? 'house' : 'all'; }; // «усі будинки» → all
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().map((r, i) => ({
    id: String(r[0]), mode: toMode(r[4]), house: String(r[5] || '').trim(), ent: Number(r[6]) || 0, row: i + 2,
    since: r[3] instanceof Date ? r[3].getTime() : (m => m ? new Date(+m[3], m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime() : 0)(
      String(r[3] || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/)),
  })).filter(x => x.id);
}

function getPref_(id) { return subsData_().find(x => x.id === String(id)) || null; }

// pref = {mode?, house?}; повертає false, якщо людина не підписана
function setPref_(id, pref) {
  const me = getPref_(id);
  if (!me) return false;
  const sh = subsSheet_();
  if (pref.mode) sh.getRange(me.row, 5).setValue(PREF_MODES[pref.mode]);
  if (pref.house !== undefined) sh.getRange(me.row, 6).setValue(pref.house ? "'" + pref.house : '');
  if (pref.ent !== undefined) sh.getRange(me.row, 7).setValue(pref.ent || '');
  return true;
}

// Таблиця «будинок + підʼїзд» в одне натискання: рядок = будинок, кнопки 1/2/3 = підʼїзд.
// cb(n) → callback_data, де n = номерБудинку*10 + підʼїзд (0 — підʼїзд невідомий)
function placeGrid_(cb, curHouse, curEnt) {
  return SOS.HOUSES.map((h, i) => {
    // без значків перед номером: у рядку 5 кнопок, і «26/13» має влазити повністю
    const row = [{ text: (h === curHouse && !curEnt ? '✅' : '') + h, callback_data: cb((i + 1) * 10) }];
    for (let e = 1; e <= SOS.ENTRANCES; e++)
      row.push({ text: (h === curHouse && e === curEnt ? '✅ ' : 'п.') + e, callback_data: cb((i + 1) * 10 + e) });
    return row;
  });
}

function settingsView_(id, pickHouse) {
  const me = getPref_(id);
  if (!me) return null;
  if (pickHouse) {
    const rows = placeGrid_(n => 'ph:' + n, me.house, me.ent);
    rows.push([{ text: '⬅️ Назад', callback_data: 'ph:0' }]);
    return { text: '🏠 <b>Ваш будинок і підʼїзд</b>' + (CFG.STREET ? ' (' + esc_(CFG.STREET) + ')' : '') + '\nУ рядку свого будинку натисніть номер підʼїзду — або сам будинок (ліворуч), якщо підʼїзд не важливий:',
      kb: { inline_keyboard: rows } };
  }
  const place = me.house ? me.house + (me.ent ? ', підʼїзд ' + me.ent : '') : '';
  const mark = m => (me.mode === m ? '✅ ' : '');
  const text = '⚙️ <b>Налаштування</b>\n\n' +
    '🆘 Тривоги «Застряг у ліфті»: <b>' + PREF_MODES[me.mode] + '</b>\n' +
    '🏠 Мій будинок: <b>' + (place || 'не вказано') + '</b>\n\n' +
    'Коли сусід застряг у ліфті, бот надсилає тривогу, щоб хтось поруч міг допомогти. ' +
    'Можна отримувати тривоги з усіх будинків, лише зі свого або вимкнути їх.\n' +
    '<i>Сповіщення про світло й графіки надходять як і раніше.</i>' +
    (me.house && me.ent ? '\n\n✅ Кнопка 🆘 одразу знатиме, де ви.' : '\n\nℹ️ Вкажіть будинок і підʼїзд — тоді кнопка 🆘 одразу знатиме, де ви, без зайвих натискань.');
  return { text: text, kb: { inline_keyboard: [
    [{ text: mark('all') + '🔔 Усі будинки', callback_data: 'pm:all' }],
    [{ text: mark('house') + '🏠 Тільки мій будинок', callback_data: 'pm:house' }],
    [{ text: mark('off') + '🔕 Вимкнути тривоги', callback_data: 'pm:off' }],
    [{ text: '🏠 ' + (place ? 'Змінити (' + place + ')' : 'Вказати будинок і підʼїзд'), callback_data: 'pc:0' }],
  ] } };
}

function prefCallback_(cq) {
  const id = String(cq.from.id), data = cq.data || '';
  const answer = t => tgCall_('answerCallbackQuery', { callback_query_id: cq.id, text: t || '' });
  const chatId = cq.message && cq.message.chat.id, msgId = cq.message && cq.message.message_id;
  const show = pick => {
    const st = settingsView_(id, pick);
    if (st) tgCall_('editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text: st.text, reply_markup: st.kb });
  };
  let m;
  if ((m = data.match(/^pm:(all|house|off)$/))) {
    if (!setPref_(id, { mode: m[1] })) return answer('Спершу підпишіться — /start');
    const me = getPref_(id);
    if (m[1] === 'house' && !me.house) { answer('Оберіть свій будинок'); return show(true); }
    answer(m[1] === 'off' ? 'Тривоги вимкнено' : 'Збережено');
    show(false);
  } else if (data === 'pc:0') {
    answer(''); show(true);
  } else if ((m = data.match(/^ph:(\d+)$/))) {
    const n = Number(m[1]), h = SOS.HOUSES[Math.floor(n / 10) - 1], e = n % 10;
    if (h && !setPref_(id, { house: h, ent: e })) return answer('Спершу підпишіться — /start');
    answer(h ? 'Збережено: ' + h + (e ? ', підʼїзд ' + e : '') : ''); show(false);
  } else answer('');
}


// ===== Графіки з публічного каналу =====
const SCHED = {
  // публічні канали-джерела (беремо найсвіжіший пост із будь-якого)
  CHANNELS: [
    { name: 'kyivsvitlo_dtek', mustHave: /Київщин/i },    // тут є й Київ — беремо лише пости по Київщині
    { name: 'svitlokyivregiondtek', mustHave: null },     // канал лише по Київщині
    { name: 'BorshchagovkaNews', mustHave: /Київськ\S*\s+обл|Київщин/i }, // новини Борщагівки — беремо лише графіки по області
    // «Вмикач Київ» — і місто, і область: беремо лише пости саме про область і без графіків для міста
    { name: 'kiev_svet', mustHave: /Київськ\S*\s+обл|Київщин/i, mustNot: /м\.\s*Київ\b|у\s+Києві|для\s+Києва|столиц/i },
    // канал Світлобота вашого ЖК — графік із сайту ДТЕК саме за адресою (без номера групи):
    // «Графік на понеділок 19 жовтня 2026: 06:00-09:30: 🔴 Світла не буде …»
    { name: CFG.SIGNAL_CHANNEL, svitlobot: true },
  ],
  GROUP: '5.2',                        // ← ЗМІНИТИ: черга ДТЕК вашого ЖК (перевірити: функція checkGroups)

  SOURCE: 'ДТЕК Київські регіональні електромережі', // підпис «Джерело: …» (порожньо '' — без підпису)
  EVERY_MIN: 5,                        // як часто перевіряти канали
  REMIND_MIN: 30,                      // за скільки хвилин попереджати про вимкнення/увімкнення (0 — вимкнути)
};

// Перевірка вручну: показує в журналі, що скрипт знайшов у каналах (нічого не розсилає)
function testSchedule() {
  SCHED.CHANNELS.forEach(ch => {
    const posts = channelPosts_(ch.name);
    const found = posts.filter(x => isSchedPost_(x, ch));
    console.log('@' + ch.name + ': постів на сторінці ' + posts.length + ', графіків: ' + found.length);
    found.forEach(x => {
      const sc = parseSched_(x.text);
      console.log('  пост ' + x.id + ' (' + Utilities.formatDate(new Date(x.time), CFG.TZ, 'dd.MM HH:mm') + ') → ' +
        (sc ? sc.date + ': ' + (sc.slots.map(y => y.join('–')).join(', ') || 'без відключень') : 'не розібрано'));
    });
  });
  const all = schedPosts_();
  const last = all[all.length - 1];
  if (last) console.log('\nНайсвіжіший графік (@' + last.ch + '), так виглядатиме повідомлення:\n' + schedMessage_(parseSched_(last.text)));
}

// Усі пости з графіками з усіх каналів, від старих до нових
function schedPosts_() {
  let all = [];
  SCHED.CHANNELS.forEach(ch => {
    try { all = all.concat(channelPosts_(ch.name).filter(x => isSchedPost_(x, ch)).map(x => Object.assign(x, { ch: ch.name }))); }
    catch (e) { console.error('Канал @' + ch.name + ': ' + e); }
  });
  return all.sort((a, b) => a.time - b.time);
}

// Викликається з check(): не частіше ніж раз на SCHED.EVERY_MIN хвилин
function pollSchedule_() {
  const p = PropertiesService.getScriptProperties();
  const now = Date.now();
  if (now - Number(p.getProperty('SCHED_AT') || 0) < SCHED.EVERY_MIN * 60000 - 20000) return;
  p.setProperty('SCHED_AT', String(now));

  const posts = schedPosts_();
  if (!posts.length) return;
  saveDays_(posts);
  const seen = JSON.parse(p.getProperty('SCHED_SEEN') || '{}'); // останній оброблений пост по кожному каналу
  const sent = JSON.parse(p.getProperty('SCHED_SENT') || '[]').map(k => { // які графіки вже розсилали (у єдиному вигляді)
    try { const i = k.indexOf('|'), sl = JSON.parse(k.slice(i + 1));
      return k.slice(0, i) + '|' + JSON.stringify(sl.length ? timeline_(sl).filter(x => !x[2]).map(x => [x[0], x[1]]) : []);
    } catch (e) { return k; }
  });
  const sentAt = JSON.parse(p.getProperty('SCHED_SENT_AT') || '{}'); // час поста останнього розісланого графіка по датах

  // нові пости з графіком; по кожній даті беремо лише НАЙСВІЖІШИЙ (за часом публікації)
  const latest = {};
  posts.forEach(post => {
    const sc = parseSched_(post.text);
    if (!sc || sc.date === '?') return;
    p.setProperty('SCHED_LAST', JSON.stringify({ s: sc }));
    if (!seen[post.ch] || post.id <= seen[post.ch]) return; // перший запуск каналу або вже бачили
    if (!latest[sc.date] || post.time >= latest[sc.date].post.time) latest[sc.date] = { post: post, sc: sc };
  });

  Object.keys(latest).forEach(date => {
    const { post, sc } = latest[date];
    const key = sc.date + '|' + JSON.stringify(sc.slots);
    if (sent.indexOf(key) >= 0) return;                         // такий графік уже розсилали
    if (sentAt[date] && post.time && post.time < sentAt[date]) return; // старіша версія, ніж уже розіслана
    const updated = sent.some(k => k.split('|')[0] === sc.date);
    // спершу запам'ятовуємо (щоб довга/перервана розсилка не повторилась), потім розсилаємо
    sent.push(key);
    sentAt[date] = post.time || Date.now();
    p.setProperties({ SCHED_SENT: JSON.stringify(sent.slice(-30)), SCHED_SENT_AT: JSON.stringify(sentAt) });
    broadcast_(schedMessage_(sc, updated));
    log_(new Date(), 'Графік на ' + sc.date + ' (@' + post.ch + ')', '', sc.slots.map(x => x.join('–')).join(', ') || 'без відключень');
  });

  // перший запуск каналу: запам'ятовуємо його графіки як уже відомі (без розсилки)
  posts.forEach(post => {
    if (seen[post.ch]) return;
    const sc = parseSched_(post.text);
    if (sc) { const k = sc.date + '|' + JSON.stringify(sc.slots); if (sent.indexOf(k) < 0) sent.push(k); }
  });
  posts.forEach(x => { seen[x.ch] = Math.max(seen[x.ch] || 0, x.id); });
  const keepAt = {}; Object.keys(sentAt).slice(-6).forEach(d => keepAt[d] = sentAt[d]);
  p.setProperty('SCHED_SENT_AT', JSON.stringify(keepAt));
  p.setProperties({ SCHED_SEEN: JSON.stringify(seen), SCHED_SENT: JSON.stringify(sent.slice(-30)) });
}

function groupRe_() { return '(?:Груп|Черг|Підчерг)\\S*'; }

function isSchedPost_(post, ch) {
  if (ch.svitlobot) return !!svitlobotSched_(post.text);
  const g = SCHED.GROUP.replace('.', '\\.');
  return (!ch.mustHave || ch.mustHave.test(post.text)) && (!ch.mustNot || !ch.mustNot.test(post.text)) &&
    new RegExp(groupRe_() + '[^\\n]*?(?:^|[^\\d.])' + g + '(?![\\d])', 'i').test(post.text);
}

// Читає сторінку t.me/s/<канал> і повертає [{id, time, text}]
function channelPosts_(name, before) {
  const html = UrlFetchApp.fetch('https://t.me/s/' + name + (before ? '?before=' + before : ''), {
    muteHttpExceptions: true, headers: { 'Accept-Language': 'uk' },
  }).getContentText();
  const out = [];
  html.split('tgme_widget_message_wrap').slice(1).forEach(chunk => {
    const idm = chunk.match(/data-post="[^"\/]+\/(\d+)"/);
    const tm = chunk.match(/<div class="tgme_widget_message_text[^"]*js-message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const dt = chunk.match(/<time[^>]*datetime="([^"]+)"/);
    if (idm && tm) out.push({ id: Number(idm[1]), time: dt ? new Date(dt[1]).getTime() || 0 : 0, text: htmlToText_(tm[1]) });
  });
  return out.sort((a, b) => a.id - b.id);
}

// Пости каналу за останні days днів (гортає сторінки назад, до maxPages сторінок)
function channelPostsDeep_(name, days, maxPages) {
  const from = Date.now() - days * 864e5, seen = {}, out = [];
  let before = 0;
  for (let i = 0; i < (maxPages || 15); i++) {
    const page = channelPosts_(name, before);
    const fresh = page.filter(p => !seen[p.id]);
    if (!fresh.length) break;
    fresh.forEach(p => { seen[p.id] = 1; out.push(p); });
    before = Math.min.apply(null, page.map(p => p.id));
    if (Math.min.apply(null, page.map(p => p.time || Date.now())) < from) break;
  }
  return out.filter(p => !p.time || p.time >= from - 864e5).sort((a, b) => a.id - b.id);
}

function htmlToText_(h) {
  return h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').trim();
}

// Витягує дату і проміжки відключень для групи SCHED.GROUP
function parseSched_(text) {
  const sb = svitlobotSched_(text);
  if (sb && !new RegExp(groupRe_() + '\\s*\\d', 'i').test(text)) return sb; // формат СвітлоБота (без номерів груп)
  const lines = text.split('\n').map(x => x.trim());
  const g = SCHED.GROUP.replace('.', '\\.');
  const head = new RegExp(groupRe_() + '[^\\n]*?(?:^|[^\\d.])' + g + '(?![\\d])', 'i');
  const start = lines.findIndex(l => head.test(l));
  if (start < 0) return null;

  // рядок групи (після назви групи) + наступні рядки до наступної групи/черги
  let block = lines[start].replace(new RegExp('^.*?' + g + '(?![\\d])\\s*:?'), '');
  const nextGroup = new RegExp(groupRe_() + '\\s*\\d', 'i');
  for (let i = start + 1; i < lines.length && !nextGroup.test(lines[i]); i++) block += '\n' + lines[i];

  const slots = [];
  const re = /(?:з\s*)?(\d{1,2}[:.]\d{2})\s*(?:до|[-–—])\s*(\d{1,2}[:.]\d{2})/g;
  let m;
  while ((m = re.exec(block))) slots.push([m[1].replace('.', ':').padStart(5, '0'), m[2].replace('.', ':').padStart(5, '0')]);

  // дата: спершу ДД.ММ.РРРР, інакше ДД.ММ (місяць 01–12)
  let dm = text.match(/(\d{1,2})\.(\d{2})\.(\d{2,4})/);
  if (!dm) { const m2 = text.match(/\b(\d{1,2})\.(\d{2})\b/); if (m2 && Number(m2[2]) >= 1 && Number(m2[2]) <= 12) dm = m2; }
  const date = dm ? dm[1].padStart(2, '0') + '.' + dm[2] : '?';
  let wd = '';
  if (dm) {
    const y = dm[3] ? Number(dm[3].length === 2 ? '20' + dm[3] : dm[3]) : new Date().getFullYear();
    wd = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п\'ятниця', 'субота'][new Date(y, Number(dm[2]) - 1, Number(dm[1])).getDay()];
  }
  // єдиний вигляд: 00:00 у кінці → 24:00, сортування, злиття повторів і перекриттів
  const norm = slots.length ? timeline_(slots).filter(x => !x[2]).map(x => [x[0], x[1]]) : [];
  return { date: date, weekday: wd, slots: norm };
}

// Графік у форматі СвітлоБота → {date, weekday, slots} або null
// «🔄 Оновлений графік на суботу 17 жовтня 2026:\n00:00-01:00: 🟢 Світло буде\n01:00-03:00: 🔴 Світла не буде …»
function svitlobotSched_(text) {
  const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  const h = text.match(/Графік\s+на\s+(\S+)\s+(\d{1,2})\s+([а-яіїєґʼ']+)\s+(\d{4})/i);
  if (!h || !/Світл[оа]\s+(?:не\s+)?буде/i.test(text)) return null;
  const mon = MONTHS.indexOf(h[3].toLowerCase());
  if (mon < 0) return null;
  const slots = [];
  const re = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s*:?[^\n]*?Світла\s+не\s+буде/gi;
  let m;
  while ((m = re.exec(text))) slots.push([m[1].padStart(5, '0'), m[2].padStart(5, '0')]);
  const norm = slots.length ? timeline_(slots).filter(x => !x[2]).map(x => [x[0], x[1]]) : [];
  const wd = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п\'ятниця', 'субота'][new Date(Number(h[4]), mon, Number(h[2])).getDay()];
  return { date: h[2].padStart(2, '0') + '.' + String(mon + 1).padStart(2, '0'), weekday: wd, slots: norm };
}

function schedMessage_(s, updated) {
  const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const today = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 864e5), CFG.TZ, 'dd.MM');
  const day = s.date === today ? 'СЬОГОДНІ' : s.date === tomorrow ? 'ЗАВТРА' : s.date;
  let msg = (updated ? '🔄 <b>Оновлено</b> графік' : '🗓 Графік') + ' відключень для групи <b>' + SCHED.GROUP + '</b> на <b>' + day + '</b>' +
    (day !== s.date ? ' (' + s.date + (s.weekday ? ', ' + s.weekday : '') + ')' : (s.weekday ? ' (' + s.weekday + ')' : '')) + ':\n\n';
  if (!s.slots.length) return msg + '✅ Відключень не заплановано, світло весь день' + (SCHED.SOURCE ? '\n\nДжерело: ' + esc_(SCHED.SOURCE) : '');

  const nowMin = s.date === today ? toMin(Utilities.formatDate(new Date(), CFG.TZ, 'HH:mm')) : -1;
  let on = 0, off = 0;
  msg += timeline_(s.slots).map(x => {
    const a = toMin(x[0]), b = toMin(x[1]) || 1440, len = b - a;
    if (x[2]) on += len; else off += len;
    return (x[2] ? '💡 ' : '🌑 ') + '<b>' + x[0] + ' — ' + x[1] + '</b> ⏱ ' + hm(len) +
      (nowMin >= a && nowMin < b ? ' ⬅️ зараз' : '');
  }).join('\n');
  const pct = m => (m / 1440 * 100).toFixed(1) + '%';
  msg += '\n\n💡 — <b>' + hm(on) + '</b> (' + pct(on) + '),  🌑 — <b>' + hm(off) + '</b> (' + pct(off) + ')';
  return msg + (SCHED.SOURCE ? '\n\nДжерело: ' + esc_(SCHED.SOURCE) : '');
}
// ===== Таблиця =====
function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CFG.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CFG.SHEET_NAME);
    sh.appendRow(['Дата', 'Час', 'Подія', 'Тривалість попереднього стану', 'Показники мережі']);
    sh.setFrozenRows(1);
    sh.getRange('A1:E1').setFontWeight('bold');
  }
  return sh;
}

function log_(date, event, duration, label) {
  sheet_().appendRow([
    Utilities.formatDate(date, CFG.TZ, 'dd.MM.yyyy'),
    hhmm_(date), event, duration, label,
  ]);
}

// ===== Утиліти =====
function prop_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('Не задано властивість скрипта ' + k);
  return v;
}

function hhmm_(d) { return Utilities.formatDate(d, CFG.TZ, 'HH:mm'); }

function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function fmtDur_(ms) {
  const m = Math.round(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return d + ' д ' + (h % 24) + ' год ' + (m % 60) + ' хв';
  if (h) return h + ' год' + (m % 60 ? ' ' + (m % 60) + ' хв' : '');
  return m + ' хв';
}

// ===== Нагадування перед вимкненням/увімкненням за графіком =====
// Зберігає графіки по датах (останній пост на кожну дату — актуальний)
function saveDays_(posts) {
  const p = PropertiesService.getScriptProperties();
  const days = JSON.parse(p.getProperty('SCHED_DAYS') || '{}');
  posts.forEach(post => { const s = parseSched_(post.text); if (s && s.date !== '?') days[s.date] = s.slots; });
  const today = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
  const keep = {}; // залишаємо лише сьогодні й майбутні (останні 4 дати)
  Object.keys(days).slice(-4).forEach(d => keep[d] = days[d]);
  p.setProperty('SCHED_DAYS', JSON.stringify(keep));
}

function remind_() {
  if (!SCHED.REMIND_MIN) return;
  const p = PropertiesService.getScriptProperties();
  const days = JSON.parse(p.getProperty('SCHED_DAYS') || '{}');
  const sent = JSON.parse(p.getProperty('REMIND_SENT') || '[]');
  const now = Date.now();
  const lead = SCHED.REMIND_MIN * 60000;
  const state = p.getProperty('STATE');

  Object.keys(days).forEach(date => {
    days[date].forEach(slot => {
      const events = [['OFF', slot[0]]];
      if (slot[1] !== '24:00') events.push(['ON', slot[1]]);
      else { // 24:00: увімкнення опівночі, лише якщо наступна доба відома й починається зі світла
        const t0 = eventTime_(date, '00:00') + 864e5;
        const next = days[Utilities.formatDate(new Date(t0 + 3600e3), CFG.TZ, 'dd.MM')];
        if (next && !next.some(sl => sl[0] === '00:00')) events.push(['ON', '00:00', t0]);
      }
      events.forEach(ev => {
        const t = ev[2] || eventTime_(date, ev[1]);
        const key = date + '|' + ev[0] + '|' + ev[1];
        if (!t || sent.indexOf(key) >= 0 || t - now > lead || t - now <= 0) return;
        sent.push(key);
        p.setProperty('REMIND_SENT', JSON.stringify(sent.slice(-40)));
        if (ev[0] === 'OFF' && state === 'OFF') return; // світла вже немає
        if (ev[0] === 'ON' && state === 'ON') return;   // світло вже є
        const note = '\n\n<i>Зазвичай перемикання відбувається протягом ±60 хвилин від вказаного часу</i>';
        broadcast_(ev[0] === 'OFF'
          ? '⚠️ О <b>' + ev[1] + '</b> за графіком <b>вимикатимуть</b> групу ' + SCHED.GROUP +
            '\n\n🔋 Рекомендуємо зарядити павербанки та пристрої.\n🛗 Не користуйтеся ліфтом за 15 хв до вимкнення.' + note
          : '💡 О <b>' + ev[1] + '</b> за графіком <b>вмикатимуть</b> групу ' + SCHED.GROUP + note);
      });
    });
  });
}

// 'dd.MM' + 'HH:mm' (час Києва) → мілісекунди
function eventTime_(date, hhmm) {
  const now = new Date();
  let y = Number(Utilities.formatDate(now, CFG.TZ, 'yyyy'));
  const [d, m] = date.split('.').map(Number);
  if (m === 1 && Number(Utilities.formatDate(now, CFG.TZ, 'MM')) === 12) y++; // перехід через Новий рік
  const pad = n => String(n).padStart(2, '0');
  try {
    return Utilities.parseDate(y + '-' + pad(m) + '-' + pad(d) + ' ' + hhmm, CFG.TZ, 'yyyy-MM-dd HH:mm').getTime();
  } catch (e) { return 0; }
}

// Нічні години за Києвом (CFG.NIGHT_FROM … CFG.NIGHT_TO)
function isNight_() {
  const h = Number(Utilities.formatDate(new Date(), CFG.TZ, 'H'));
  return CFG.NIGHT_FROM > CFG.NIGHT_TO ? (h >= CFG.NIGHT_FROM || h < CFG.NIGHT_TO) : (h >= CFG.NIGHT_FROM && h < CFG.NIGHT_TO);
}

// Діагностика: що бачить Telegram (адреса вебхука, остання помилка)
function webhookInfo() {
  console.log(UrlFetchApp.fetch(tgUrl_('getWebhookInfo')).getContentText());
}

// Останній графік для /grafik (зберігаємо дані, а текст збираємо заново — так переноси рядків не губляться)
function lastSchedText_() {
  const p = PropertiesService.getScriptProperties();
  // сьогодні й завтра з усіх збережених графіків
  try {
    const days = JSON.parse(p.getProperty('SCHED_DAYS') || '{}');
    const today = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
    const tomorrow = Utilities.formatDate(new Date(Date.now() + 864e5), CFG.TZ, 'dd.MM');
    const wd = d => { const [dd, mm] = d.split('.').map(Number); const y = new Date().getFullYear() + (mm === 1 && new Date().getMonth() === 11 ? 1 : 0);
      return ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п\'ятниця', 'субота'][new Date(y, mm - 1, dd).getDay()]; };
    const parts = [today, tomorrow].filter(d => days[d]).map(d => schedMessage_({ date: d, weekday: wd(d), slots: days[d] }).replace(/\n\nДжерело:[^\n]*$/, ''));
    if (parts.length) return parts.join('\n\n———\n\n') + (SCHED.SOURCE ? '\n\nДжерело: ' + esc_(SCHED.SOURCE) : '');
  } catch (e) { console.error('grafik: ' + e); }
  try {
    const d = JSON.parse(p.getProperty('SCHED_LAST'));
    if (d && d.s) return schedMessage_(d.s);
  } catch (e) {}
  // старий формат або порожньо — перечитаємо канал при наступній перевірці
  p.deleteProperty('SCHED_AT');
  return '🕐 Очікуємо графік відключень від ДТЕК для групи ' + SCHED.GROUP + '.\nЩойно його опублікують — бот надішле автоматично.';
}

// Добовий розклад по черзі: [початок, кінець, чи є світло]
function timeline_(slots) {
  const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const toStr = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const off = slots.map(x => [toMin(x[0]), toMin(x[1]) <= toMin(x[0]) ? 1440 : toMin(x[1])])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = 0;
  off.forEach(([a, b]) => {
    if (a > cur) out.push([cur, a, true]);
    if (b > cur) { out.push([Math.max(a, cur), b, false]); cur = b; }
  });
  if (cur < 1440) out.push([cur, 1440, true]);
  return out.map(x => [toStr(x[0]), toStr(x[1]), x[2]]);
}

// Майбутні перемикання за графіком [{t, on}], від найближчого.
// Північ — теж подія, якщо стан змінюється (напр. сьогодні 23:00–24:00 темно, завтра з 00:00 світло).
function schedEvents_(days) {
  const now = Date.now(), ev = [];
  Object.keys(days).forEach(date => {
    timeline_(days[date]).forEach(x => {
      if (x[0] === '00:00') {
        const prev = Utilities.formatDate(new Date(eventTime_(date, '00:00') - 3600e3), CFG.TZ, 'dd.MM');
        const ptl = days[prev] ? timeline_(days[prev]) : null;
        if (!ptl || !ptl.length || ptl[ptl.length - 1][2] === x[2]) return; // стан не змінюється (або попередня доба невідома)
      }
      const t = eventTime_(date, x[0]);
      if (t > now) ev.push({ t: t, on: x[2] });
    });
  });
  return ev.sort((a, b) => a.t - b.t);
}

// ===== /next — найближчі події за графіком =====
function nextText_() {
  const days = JSON.parse(PropertiesService.getScriptProperties().getProperty('SCHED_DAYS') || '{}');
  const now = Date.now();
  const ev = schedEvents_(days);
  // прибираємо «події», що нічого не змінюють (напр. стик двох діб)
  const list = ev.filter((e, i) => i === 0 || e.on !== ev[i - 1].on).slice(0, 2);
  if (!list.length) {
    const today = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
    return (days[today]
      ? '✅ До кінця дня відключень за графіком не заплановано.\n\n🕐 Графік на завтра ще не опубліковано — очікуємо інформацію від ДТЕК.'
      : '🕐 Очікуємо графік відключень від ДТЕК для групи ' + SCHED.GROUP + '.') +
      '\nЩойно його опублікують — бот надішле автоматично.';
  }
  const when = t => {
    const today = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
    const d = Utilities.formatDate(new Date(t), CFG.TZ, 'dd.MM');
    return (d === today ? 'сьогодні' : d === Utilities.formatDate(new Date(Date.now() + 864e5), CFG.TZ, 'dd.MM') ? 'завтра' : d) +
      ' о <b>' + hhmm_(new Date(t)) + '</b>';
  };
  return list.map((e, i) => (e.on ? '💡 ' : '🌑 ') + (i ? 'Потім ' : 'Наступне ') +
    (e.on ? '<b>увімкнення</b>' : '<b>вимкнення</b>') + ': ' + when(e.t) +
    (i ? '' : ' (через ' + fmtDur_(e.t - now) + ')')).join('\n') +
    '\n\n<i>За графіком групи ' + SCHED.GROUP + ', можливе відхилення ±60 хв</i>';
}

// ===== /stats — статистика з листа «Світло» =====
function statsText_() {
  const outs = outages_();
  if (!outs.length) return '📊 Відключень ще не зафіксовано (статистика ведеться з початку моніторингу).';
  const dayStart = off => Utilities.parseDate(Utilities.formatDate(new Date(Date.now() - off * 864e5), CFG.TZ, 'yyyy-MM-dd') + ' 00:00',
    CFG.TZ, 'yyyy-MM-dd HH:mm').getTime();
  const sum = (from, to) => {
    let ms = 0, n = 0;
    outs.forEach(o => {
      const a = Math.max(o[0], from), b = Math.min(o[1], to);
      if (b > a) { ms += b - a; n++; }
    });
    return { ms: ms, n: n };
  };
  const now = Date.now();
  const today = sum(dayStart(0), now);
  const yest = sum(dayStart(1), dayStart(0));
  const week = sum(dayStart(6), now);
  const longest = outs.filter(o => o[1] > dayStart(6)).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  const line = (name, r) => name + ': <b>' + (r.ms ? fmtDur_(r.ms) : '0 хв') + '</b> без світла' + (r.n ? ' (' + r.n + ' відкл.)' : '');
  let msg = '📊 <b>Статистика відключень</b>\n\n' + line('Сьогодні', today) + '\n' + line('Вчора', yest) + '\n' + line('За 7 днів', week);
  const daysWatched = Math.min(7, Math.max(1, Math.ceil((now - Math.max(outs[0][0], dayStart(6))) / 864e5)));
  if (week.ms && daysWatched > 1) msg += '\nУ середньому: <b>' + fmtDur_(week.ms / daysWatched) + '</b> на добу';
  if (longest) msg += '\n\nНайдовше за тиждень: <b>' + fmtDur_(longest[1] - longest[0]) + '</b> (' +
    Utilities.formatDate(new Date(longest[0]), CFG.TZ, 'dd.MM HH:mm') + ' — ' + hhmm_(new Date(longest[1])) + ')';
  return msg + '\n\n' + statusText_();
}

// Відключення з листа «Світло»: [[початок, кінець], …] у мілісекундах
function outages_() {
  const sh = sheet_();
  if (sh.getLastRow() < 2) return [];
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  const out = [];
  let start = null;
  rows.forEach(r => {
    const d = r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'dd.MM.yyyy') : String(r[0]).trim();
    const t = r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'HH:mm') : String(r[1]).trim();
    let ts;
    try { ts = Utilities.parseDate(d + ' ' + t, CFG.TZ, 'dd.MM.yyyy HH:mm').getTime(); } catch (e) { return; }
    const ev = String(r[2]);
    if (/Світло зникло|світло немає/.test(ev)) { if (start === null) start = ts; }
    else if (/Світло з.явилося|світло є/.test(ev)) { if (start !== null) { out.push([start, ts]); start = null; } }
  });
  if (start !== null) out.push([start, Date.now()]); // відключення триває зараз
  return out;
}

function morningReport_(now, adminOnly) {
  const h = Number(Utilities.formatDate(now, CFG.TZ, 'H'));
  if (!adminOnly && (h < CFG.REPORT_HOUR || h >= CFG.REPORT_HOUR + 3)) return;
  const p = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(now, CFG.TZ, 'dd.MM');
  if (!adminOnly && p.getProperty('REPORT_SENT') === today) return;
  if (!adminOnly) p.setProperty('REPORT_SENT', today); // спершу позначаємо, щоб не надіслати двічі

  const pad = n => String(n).padStart(2, '0');
  const from = Utilities.parseDate(Utilities.formatDate(new Date(now.getTime() - 864e5), CFG.TZ, 'yyyy-MM-dd') + ' ' +
    pad(CFG.NIGHT_FROM) + ':00', CFG.TZ, 'yyyy-MM-dd HH:mm').getTime();
  let msg = '🌅 <b>Доброго ранку!</b>';

  // відключення за ніч
  let off = 0;
  outages_().forEach(o => { const a = Math.max(o[0], from), b = Math.min(o[1], now.getTime()); if (b > a) off += b - a; });
  msg += '\n\n' + (off >= 60000 ? '🌑 Вночі (' + pad(CFG.NIGHT_FROM) + ':00–' + pad(CFG.REPORT_HOUR) + ':00) світла не було: <b>' + fmtDur_(off) + '</b>'
    : '💡 Вночі світло не вимикали');
  msg += '\n' + statusText_();

  // графік на сьогодні
  const days = JSON.parse(p.getProperty('SCHED_DAYS') || '{}');
  if (days[today]) msg += '\n\n🗓 ' + (days[today].length
    ? 'Сьогодні вимкнення світла за графіком: ' + days[today].map(x => '<b>' + x[0] + '–' + x[1] + '</b>').join(', ')
    : 'Сьогодні вимкнень світла за графіком не заплановано');

  if (adminOnly) send_(p.getProperty('TG_ADMIN_ID').trim(), '(тест, лише вам)\n\n' + msg);
  else broadcast_(msg);
}

// Підпис під повідомленнями: «НАЗВА Світло | ☕ На каву» (банка — з властивості DONATE_URL)
function footer_() {
  const parts = [];
  if (CFG.BOT_URL) parts.push('<a href="' + CFG.BOT_URL + '">' + esc_(CFG.BOT_NAME) + '</a>');
  const jar = (PropertiesService.getScriptProperties().getProperty('DONATE_URL') || '').trim();
  // напис можна змінити без оновлення коду: властивість DONATE_TEXT (разом з емодзі, напр. «💙 Підтримати бот»)
  const label = (PropertiesService.getScriptProperties().getProperty('DONATE_TEXT') || '').trim() || '☕ ' + CFG.DONATE_TEXT;
  if (/^https?:\/\//.test(jar)) parts.push('<a href="' + esc_(trackUrl_('kava', jar)) + '">' + esc_(label) + '</a>');
  let ad = '';
  try {
    const a = JSON.parse(PropertiesService.getScriptProperties().getProperty('AD_FOOTER') || 'null');
    if (a && a.text && a.url) ad = '\n📣 <a href="' + esc_(trackUrl_(a.slug, a.url)) + '">' + esc_(a.text) + '</a> <i>· реклама</i>';
  } catch (e) {}
  return parts.length || ad ? '\n' + ad + '\n' + parts.join(' | ') : '';
}

// ===== Лічильник переходів за посиланнями (через Cloudflare: …workers.dev/go/мітка) =====
const CLICKS = { SHEET: 'Переходи', DAYS: 30 };

// Посилання з підрахунком переходів. Без PROXY_URL/CF_KEY — повертає звичайне посилання.
function trackUrl_(slug, url) {
  const p = PropertiesService.getScriptProperties();
  const proxy = (p.getProperty('PROXY_URL') || '').trim().replace(/\/+$/, '');
  const key = (p.getProperty('CF_KEY') || '').trim();
  if (!proxy || !key || !/^https?:\/\//.test(url)) return url;
  slug = String(slug || 'link').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'link';
  const sig = Utilities.computeHmacSha256Signature(slug + '|' + url, key)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 16);
  const u = Utilities.base64EncodeWebSafe(url, Utilities.Charset.UTF_8).replace(/=+$/, '');
  return proxy + '/go/' + slug + '?u=' + u + '&s=' + sig;
}

// «[текст](https://…)» у /post → посилання з лічильником
function linkify_(escapedText, slug) {
  return escapedText.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, t, url) => '<a href="' + esc_(trackUrl_(slug, url.replace(/&amp;/g, '&'))) + '">' + t + '</a>');
}

function clickSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CLICKS.SHEET);
  if (!sh) {
    sh = ss.insertSheet(CLICKS.SHEET);
    sh.appendRow(['Дата', 'Час', 'Мітка', 'Відвідувач (анонімно)', 'TS']);
    sh.setFrozenRows(1);
    sh.getRange('A1:E1').setFontWeight('bold');
  }
  return sh;
}

function recordClick_(slug, visitor) {
  const now = new Date();
  clickSheet_().appendRow([Utilities.formatDate(now, CFG.TZ, 'dd.MM.yyyy'), hhmm_(now),
    String(slug || '').slice(0, 30), String(visitor || '').slice(0, 16), now.getTime()]);
}

function clicksText_() {
  const sh = clickSheet_();
  if (sh.getLastRow() < 2) return '🔗 Переходів поки немає.\n\nСтворіть посилання: /link назва https://…\nабо рекламу в підписі: /ad Текст | https://…';
  const now = Date.now(), dayStart = new Date(Utilities.formatDate(new Date(), CFG.TZ, "yyyy-MM-dd'T'00:00:00XXX")).getTime();
  const by = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(r => {
    const ts = Number(r[4]) || 0;
    if (now - ts > CLICKS.DAYS * 864e5) return;
    const k = String(r[2]);
    const x = by[k] = by[k] || { all: 0, week: 0, today: 0, uniq: {}, last: 0 };
    x.all++; x.uniq[r[3]] = 1; x.last = Math.max(x.last, ts);
    if (now - ts < 7 * 864e5) x.week++;
    if (ts >= dayStart) x.today++;
  });
  const keys = Object.keys(by).sort((a, b) => by[b].last - by[a].last).slice(0, 15);
  if (!keys.length) return '🔗 За останні ' + CLICKS.DAYS + ' днів переходів немає.';
  return '🔗 <b>Переходи за посиланнями</b> (' + CLICKS.DAYS + ' днів)\n\n' + keys.map(k => {
    const x = by[k];
    return '<b>' + esc_(k) + '</b>: ' + x.all + ' переходів, ' + Object.keys(x.uniq).length + ' людей' +
      '\n   сьогодні ' + x.today + ' · за 7 днів ' + x.week;
  }).join('\n') + '\n\n<i>«Людей» — приблизно: рахуємо різні пристрої, без збереження особистих даних.</i>';
}

// ===== Опитування: одне опитування Telegram пересилається всім — голоси рахуються разом =====
function broadcastPoll_(adminId, question, options) {
  const r = JSON.parse(UrlFetchApp.fetch(tgUrl_('sendPoll'), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ chat_id: adminId, question: question.slice(0, 300),
      options: options.map(o => ({ text: o.slice(0, 100) })), is_anonymous: true }),
  }).getContentText());
  if (!r.ok) { console.error('sendPoll: ' + r.description); return -1; }
  const msgId = r.result.message_id;
  PropertiesService.getScriptProperties().setProperty('LAST_POLL', JSON.stringify({ chat: adminId, id: msgId, q: question }));
  const ids = subs_().filter(x => x !== String(adminId));
  const res = massSend_(ids, 'forwardMessage', { from_chat_id: adminId, message_id: msgId, disable_notification: isNight_() });
  recordBroadcast_('Опитування', question, res);
  statDelivered_('📊 Опитування', res.n);
  return res.n;
}

// ===== Контекст графіка для повідомлень «увімкнули/вимкнули» =====
// Поточна зона графіка, наявність світла в цьому проміжку за останні дні і наступна подія
function zoneText_(isOn) {
  const days = JSON.parse(PropertiesService.getScriptProperties().getProperty('SCHED_DAYS') || '{}');
  const now = Date.now();
  const today = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM');
  if (!days[today]) return '';
  // поточна зона
  const zone = timeline_(days[today]).find(x => {
    const a = eventTime_(today, x[0]), b = x[1] === '24:00' ? a + (toMin_('24:00') - toMin_(x[0])) * 60000 : eventTime_(today, x[1]);
    return now >= a && now < b;
  });
  let msg = '';
  if (zone) {
    msg += '\n\n' + (zone[2] ? '⚪️ Зараз діє <b>світла</b>' : '⚫️ Зараз діє <b>темна</b>') +
      ' зона графіка: <b>з ' + zone[0] + ' по ' + zone[1] + '</b>';
    const pct = zoneLightPct_(zone[0], zone[1]);
    if (pct) msg += ', наявність світла в цьому проміжку за останні ' + pct.days + ' дн.: <b>' + pct.pct + '%</b>';
    if (zone[2] !== isOn) msg += '\n' + (isOn ? '🙂 Світло дали раніше графіка' : '⚠️ Світло вимкнули поза графіком');
  }
  // наступна подія за графіком
  const next = schedEvents_(days).find(e => e.on !== isOn);
  if (next) {
    const d = Utilities.formatDate(new Date(next.t), CFG.TZ, 'dd.MM');
    const tomorrow = Utilities.formatDate(new Date(now + 864e5), CFG.TZ, 'dd.MM');
    msg += '\n\n' + (next.on ? '🌗 Наступне <b>увімкнення</b>' : '🌘 Наступне <b>вимкнення</b>') + ' згідно графіка <b>' +
      (d === today ? 'сьогодні' : d === tomorrow ? 'завтра' : d) + ' о ' + hhmm_(new Date(next.t)) + '</b> (через ' + fmtDur_(next.t - now) + ')';
  }
  return msg;
}

function toMin_(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); }

// Частка часу зі світлом у проміжку [from, to) доби за останні дні моніторингу (до 14)
function zoneLightPct_(from, to) {
  const outs = outages_();
  const sh = sheet_();
  if (sh.getLastRow() < 2) return null;
  const first = outs.length ? Math.min(outs[0][0], Date.now()) : Date.now();
  let total = 0, dark = 0, n = 0;
  for (let k = 1; k <= 14; k++) {
    const day = Utilities.formatDate(new Date(Date.now() - k * 864e5), CFG.TZ, 'dd.MM');
    const a = eventTime_(day, from);
    const b = a + ((toMin_(to) || 1440) - toMin_(from)) * 60000;
    if (!a || b > Date.now()) continue;
    if (a < monitorStart_()) break;
    n++; total += b - a;
    outs.forEach(o => { const x = Math.max(o[0], a), y = Math.min(o[1], b); if (y > x) dark += y - x; });
  }
  if (!n || !total) return null;
  return { days: n, pct: (100 * (total - dark) / total).toFixed(1) };
}

function monitorStart_() {
  const p = PropertiesService.getScriptProperties();
  let t = Number(p.getProperty('MONITOR_START') || 0);
  if (!t) {
    const sh = sheet_();
    const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
    const r = sh.getRange(2, 1, 1, 2).getValues()[0];
    const d = r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'dd.MM.yyyy') : String(r[0]).trim();
    const tt = r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'HH:mm') : String(r[1]).trim();
    try { t = Utilities.parseDate(d + ' ' + tt, CFG.TZ, 'dd.MM.yyyy HH:mm').getTime(); } catch (e) { t = Date.now(); }
    p.setProperty('MONITOR_START', String(t));
  }
  return t;
}
// ======================================================================
// ===== 🆘 ЗАСТРЯГ У ЛІФТІ =====
// Властивості скрипта:
//   LIFT_PHONE   – номер аварійної служби ліфтів, напр. +380441234567 (обовʼязково)
//   SOS_CHAT_ID  – (необовʼязково) чат ОСББ/будинку, куди теж іде тривога
// Тривога одразу йде адміну (і в SOS_CHAT_ID), а всім підписникам — щойно людина обере
// будинок і підʼїзд (або через 1 хв, якщо не обрала).
// ======================================================================
const SOS = {
  HOUSES: ['1', '2', '3'],   // ← ЗМІНИТИ: номери будинків ЖК (до ~20; коротко, напр. '26/13')
  ENTRANCES: 4,          // ← ЗМІНИТИ за потреби: скільки підʼїздів показувати (1–4)
  ALL_AFTER_MIN: 1,      // якщо місце не обрано — тривога всім через стільки хв
  ESCALATE_MIN: 3,       // якщо ніхто не відгукнувся за стільки хв — нагадування адміну
  MAX_ALL_PER_DAY: 2,    // скільки разів на добу одна людина може підняти тривогу для всіх
  ADMIN_REMIND_MIN: 3,   // адмін ще не вирішив — нагадати йому і спитати людину «Ви досі в ліфті?»
  TRUST_SUB_HOURS: 24,   // «перевірений» сусід: підписаний щонайменше стільки годин
  TRUST_POWER_MIN: 15,   // якщо світло зникло не більше стількох хв тому — довіряємо й новим підписникам
  AUTO_SEND_MIN: 0,      // через скільки хв розіслати сусідам самостійно, якщо адмін мовчить (0 — ніколи, лише вручну)
  ASK_MIN: 10,           // через скільки хв запитати застряглого «Вас уже звільнили?»
  CLOSE_MIN: 120,        // автоматично закрити тривогу через стільки хв
  MAX_PER_HOUR: 3,       // не більше тривог від однієї людини за годину
};

// LIFT_PHONE може містити кілька номерів через кому: «0800501901, +380XXXXXXXXX»
function liftPhones_() {
  return (PropertiesService.getScriptProperties().getProperty('LIFT_PHONE') || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
}
function liftPhone_() { return liftPhones_().join(' або '); }

// Під час повітряної тривоги механік не виїжджає
const SOS_RAID_NOTE = '⚠️ Під час повітряної тривоги механік не виїжджає — приїде після відбою. Тому важлива допомога сусідів.';

function sosInstr_(pending) {
  const ph = liftPhone_();
  return (pending ? '🆘 <b>Залишайтеся спокійними.</b>\n\n' : '🆘 <b>Залишайтеся спокійними — тривогу передано.</b>\n\n') +
    (ph ? '📞 Аварійна служба ліфтів: <b>' + esc_(ph) + '</b>\n' : '') +
    '🔔 Натисніть кнопку виклику диспетчера в кабіні\n' +
    '⛔ Не намагайтеся самостійно відкрити двері чи вилізти\n' +
    '🚒 Якщо погано почуваєтеся або є загроза життю — <b>101</b> / <b>112</b>\n' + SOS_RAID_NOTE;
}

function tgCall_(method, payload) {
  const r = UrlFetchApp.fetch(tgUrl_(method), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload),
  });
  try { return JSON.parse(r.getContentText()); } catch (e) { return { ok: false }; }
}

// Окремий замок для тривог: перевірка світла тримає ScriptLock до 30 с (розсилки, графіки),
// і натискання кнопок 🆘 не повинні на неї чекати
function sosLock_() { return LockService.getDocumentLock() || LockService.getScriptLock(); }

function sosGet_() { return JSON.parse(PropertiesService.getScriptProperties().getProperty('SOS_ACTIVE') || '{}'); }
function sosPut_(all) { PropertiesService.getScriptProperties().setProperty('SOS_ACTIVE', JSON.stringify(all)); }

function userLink_(u) {
  const name = esc_([u.first_name, u.last_name].filter(Boolean).join(' ') || 'Сусід');
  return '<a href="tg://user?id=' + u.id + '">' + name + '</a>' + (u.username ? ' (@' + esc_(u.username) + ')' : '');
}

function sosPlace_(a) {
  if (!a.house && !a.ent) return 'Будинок не вказано';
  return (a.house ? 'Будинок <b>' + esc_(a.house) + '</b>' : 'Будинок не вказано') +
    (a.ent ? ', підʼїзд <b>' + a.ent + '</b>' : '');
}

function sosActions_(id) {
  return { inline_keyboard: [
    [{ text: '✋ Я йду допомогти', callback_data: 'sg:' + id }],
    [{ text: '📞 Викликав аварійку', callback_data: 'sc:' + id }, { text: '✅ Звільнили', callback_data: 'sd:' + id }],
    [{ text: '❌ Хибна тривога — скасувати', callback_data: 'sx:' + id }],
  ] };
}

// Старт тривоги (test = лише адміну)
function sosStart_(chat, test) {
  const lock = sosLock_();
  lock.waitLock(15000);
  let a;
  try {
    const all = sosGet_();
    const uid = String(chat.id);
    const mine = Object.keys(all).map(k => all[k]).find(x => x.uid === uid);
    if (mine) { // вже є активна тривога — просто нагадуємо інструкцію
      send_(uid, sosInstr_() + '\n\nВаша тривога <b>#' + mine.id + '</b> активна.', false, sosUserKb_(mine.id, 'done'));
      return;
    }
    const p = PropertiesService.getScriptProperties();
    var trust = sosTrust_(uid);
    if (trust === 'ban' && !test) {
      send_(uid, sosInstr_(true) + '\n\n⚠️ Тривоги від вашого акаунта тимчасово недоступні. Телефонуйте напряму за номерами вище.');
      return;
    }
    const hist = JSON.parse(p.getProperty('SOS_HIST') || '{}');
    const recent = (hist[uid] || []).filter(t => Date.now() - t < 3600e3);
    if (!test && recent.length >= SOS.MAX_PER_HOUR) {
      send_(uid, sosInstr_() + '\n\n⚠️ Забагато тривог за годину. Телефонуйте напряму за номерами вище.');
      return;
    }
    hist[uid] = recent.concat(Date.now()).slice(-5);
    p.setProperty('SOS_HIST', JSON.stringify(hist));
    const n = Number(p.getProperty('SOS_N') || 0) + 1;
    p.setProperty('SOS_N', String(n));
    const dayAll = (hist[uid] || []).filter(t => Date.now() - t < 864e5).length;
    const myPref = getPref_(uid) || {};
    a = { id: n, uid: uid, who: userLink_(chat), t: Date.now(), house: myPref.house || '', ent: myPref.house ? myPref.ent || 0 : 0, go: [], called: false,
      allSent: !test && dayAll > SOS.MAX_ALL_PER_DAY, // ліміт масових тривог — далі лише адміну
      esc: false, ask: false, test: !!test, pending: true, trust: trust };
    all[n] = a;
    sosPut_(all);
  } finally { lock.releaseLock(); }

  // 1) застряглому — одразу інструкція + вибір будинку / підʼїзду
  if (a.house && a.ent) send_(a.uid, sosInstr_() + '\n\n📍 ' + sosPlace_(a) + ' (з ваших налаштувань)\n' +
    'Якщо ви в іншому місці — натисніть «📍 Змінити місце».', false, sosUserKb_(a.id, 'done'));
  else if (a.house) send_(a.uid, sosInstr_() + '\n\n📍 ' + sosPlace_(a) + ' (з ваших налаштувань)\nОберіть підʼїзд:', false, sosUserKb_(a.id, 'ent'));
  else send_(a.uid, sosInstr_() + '\n\n📍 <b>Де ви?</b> Натисніть номер підʼїзду в рядку свого будинку — так допомога знайде вас швидше:',
    false, sosUserKb_(a.id, 'house'));
  // 2) повна адреса + перевірений сусід — одразу всім (чат ОСББ і сусіди)
  if (a.house && a.ent && a.trust === 'ok') {
    sosLog_(a, 'Тривога', (a.test ? 'тест, ' : '') + 'автоматично: повна адреса, перевірений');
    return sosAutoApprove_(a, 'trust');
  }
  // інакше — адміну: він вирішує, чи розсилати (через ADMIN_REMIND_MIN хв бот спитає і саму людину)
  const r = tgCall_('sendMessage', { chat_id: (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim(),
    text: sosPendingText_(a), parse_mode: 'HTML', reply_markup: sosPendingKb_(a.id) });
  if (r.ok) {
    const lock2 = sosLock_();
    lock2.waitLock(10000);
    try { const all = sosGet_(); if (all[a.id]) { all[a.id].amsg = r.result.message_id; sosPut_(all); } a.amsg = r.result.message_id; }
    finally { lock2.releaseLock(); }
  }
  sosLog_(a, 'Тривога', (a.test ? 'тест, ' : '') + 'чекає рішення (' + SOS_TRUST_LABEL[a.trust].replace(/^\S+\s/, '') + ')');
}

// Довіра до того, хто натиснув 🆘: 'ok' — розсилаємо одразу (якщо адреса повна), 'new' — через адміна
// або підтвердження людини, 'flag' — була хибна тривога (лише вручну), 'ban' — тривоги заблоковано
function sosTrust_(uid) {
  const p = PropertiesService.getScriptProperties();
  if (JSON.parse(p.getProperty('SOS_BAN') || '[]').indexOf(uid) >= 0) return 'ban';
  if (JSON.parse(p.getProperty('SOS_FALSE') || '{}')[uid]) return 'flag';
  if (p.getProperty('STATE') === 'OFF' && Date.now() - Number(p.getProperty('SINCE') || 0) <= SOS.TRUST_POWER_MIN * 60000) return 'ok';
  const me = getPref_(uid);
  if (me && me.since && Date.now() - me.since >= SOS.TRUST_SUB_HOURS * 3600e3) return 'ok';
  return 'new';
}

const SOS_TRUST_LABEL = { ok: '✅ перевірений сусід', new: '🆕 новий підписник (менше доби)',
  flag: '⚠️ раніше була хибна тривога — лише вручну', ban: '🚫 заблоковано' };

// Розіслати без адміна: how = 'trust' (повна адреса + довіра) або 'confirm' (людина підтвердила «досі в ліфті»)
function sosAutoApprove_(a, how) {
  const lock = sosLock_();
  lock.waitLock(10000);
  try {
    const all = sosGet_(), cur = all[a.id];
    if (!cur || !cur.pending) return;
    cur.pending = false; cur.tc = Date.now(); cur.massNow = !cur.allSent; cur.allSent = true;
    Object.assign(a, cur);
    sosPut_(all);
  } finally { lock.releaseLock(); }
  if (a.massNow) sosApprove_(a, how);
  else sosNotify_('🆘 <b>ЗАСТРЯГЛИ В ЛІФТІ!</b> #' + a.id + '\n\n👤 ' + a.who + '\n📍 ' + sosPlace_(a), sosActions_(a.id), a);
}

function sosBan_(uid, on) {
  const p = PropertiesService.getScriptProperties();
  let ban = JSON.parse(p.getProperty('SOS_BAN') || '[]').filter(x => x !== uid);
  if (on) ban.push(uid);
  p.setProperty('SOS_BAN', JSON.stringify(ban));
  if (!on) { const fl = JSON.parse(p.getProperty('SOS_FALSE') || '{}'); delete fl[uid]; p.setProperty('SOS_FALSE', JSON.stringify(fl)); }
}

function sosAdmin_(html, markup) {
  const admin = (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim();
  if (admin) send_(admin, html, false, markup);
}

function sosPendingText_(a) {
  return '🆘 <b>Натиснули «Застряг у ліфті»</b>' + (a.test ? ' <i>(тест)</i>' : '') + ' #' + a.id + '\n\n' +
    '👤 ' + a.who + '\n🕐 ' + hhmm_(new Date(a.t)) + '\n📍 ' + sosPlace_(a) +
    (liftPhone_() ? '\n📞 Аварійка ліфтів: ' + esc_(liftPhone_()) : '') +
    '\n🛡 ' + (SOS_TRUST_LABEL[a.trust] || '') +
    '\n\n⏸ Сусідам і в чат ще <b>не надіслано</b>. Якщо тривога справжня — натисніть «📣 Розіслати тривогу».' +
    (a.trust === 'flag' ? '' : '\nЯкщо не вирішите за ' + SOS.ADMIN_REMIND_MIN + ' хв — бот спитає людину, чи вона досі в ліфті, і після «Так» розішле сам.') +
    '\n<i>Можна написати людині: натисніть на її імʼя.</i>';
}

function sosPendingKb_(id) {
  return { inline_keyboard: [
    [{ text: '📣 Розіслати тривогу сусідам', callback_data: 'sa:' + id }],
    [{ text: '✋ Я йду', callback_data: 'sg:' + id }, { text: '📞 Викликав аварійку', callback_data: 'sc:' + id }],
    [{ text: '❌ Хибна тривога', callback_data: 'sx:' + id }],
  ] };
}

// Адмін підтвердив (або спрацювало AUTO_SEND_MIN): тривога в чат ОСББ і всім сусідам
function sosApprove_(a, auto) {
  if (a.amsg) tgCall_('editMessageText', { chat_id: (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim(),
    message_id: a.amsg, parse_mode: 'HTML', text: sosPendingText_(a).replace(/\n\n⏸[\s\S]*$/, '') +
      '\n\n📣 <b>Розіслано</b>' + (auto === 'trust' ? ' автоматично: повна адреса, перевірений сусід' :
        auto === 'confirm' ? ' автоматично: людина підтвердила, що досі в ліфті' :
        auto ? ' автоматично (ви не відповіли за ' + SOS.AUTO_SEND_MIN + ' хв)' : '') + '.' });
  sosNotify_('🆘 <b>ЗАСТРЯГЛИ В ЛІФТІ!</b>' + (a.test ? ' <i>(тест)</i>' : '') + ' #' + a.id + '\n\n' +
    '👤 ' + a.who + '\n🕐 ' + hhmm_(new Date(a.t)) + '\n📍 ' + sosPlace_(a) +
    (liftPhone_() ? '\n\n📞 Аварійка ліфтів: ' + esc_(liftPhone_()) : ''), sosActions_(a.id), a);
  send_(a.uid, '📣 Тривогу надіслано сусідам — допомога шукається. Ми напишемо, коли хтось іде.', false, sosUserKb_(a.id, 'done'));
  sosMass_(a);
  sosLog_(a, 'Розіслано', auto === 'trust' ? 'автоматично (довіра)' : auto === 'confirm' ? 'людина підтвердила' : auto ? 'автоматично' : 'адмін підтвердив');
}

// Клавіатура застряглого: вибір підʼїзду / поверху / «мене звільнили»
function sosUserKb_(id, step) {
  const rows = [];
  if (step === 'house') { // будинок і підʼїзд — одним натисканням
    placeGrid_(n => 'sp:' + id + ':' + n).forEach(r => rows.push(r));
    rows.push([{ text: 'Не знаю / пропустити', callback_data: 'sp:' + id + ':0' }]);
  } else if (step === 'ent') {
    const b = [];
    for (let i = 1; i <= SOS.ENTRANCES; i++) b.push({ text: (SOS.ENTRANCES > 3 ? 'П. ' : 'Підʼїзд ') + i, callback_data: 'se:' + id + ':' + i });
    rows.push(b);
    rows.push([{ text: 'Не знаю / пропустити', callback_data: 'se:' + id + ':0' }]);
    rows.push([{ text: '🏠 Інший будинок', callback_data: 'sh:' + id + ':99' }]);
  }
  if (step === 'done') rows.push([{ text: '📍 Змінити місце', callback_data: 'sh:' + id + ':99' }]);
  rows.push([{ text: '✅ Мене звільнили', callback_data: 'sd:' + id }]);
  if (step !== 'done') rows.push([{ text: '❌ Натиснув випадково — скасувати', callback_data: 'sx:' + id }]);
  else rows.push([{ text: '❌ Тривога помилкова — скасувати', callback_data: 'sx:' + id }]);
  if (liftPhone_()) rows.push([{ text: '📇 Зберегти номер аварійки', callback_data: 'sk:0' }]);
  return { inline_keyboard: rows };
}

// Кому йде тривога: адмін і чат ОСББ (тест — лише адмін)
function sosRecipients_(a) {
  const p = PropertiesService.getScriptProperties();
  const admin = (p.getProperty('TG_ADMIN_ID') || '').trim();
  if (a && (a.test || a.pending)) return admin && (!a || admin !== a.uid || a.test) ? [admin] : [];
  const ids = [admin];
  const chat = (p.getProperty('SOS_CHAT_ID') || '').trim();
  if (chat) ids.push(chat);
  return ids.filter((x, i) => x && ids.indexOf(x) === i && (!a || x !== a.uid));
}

function sosNotify_(html, markup, a) {
  const ids = sosRecipients_(a);
  if (!ids.length) return 0;
  const res = UrlFetchApp.fetchAll(ids.map(id => ({
    url: tgUrl_('sendMessage'), method: 'post', muteHttpExceptions: true,
    payload: { chat_id: id, text: html, parse_mode: 'HTML', disable_web_page_preview: 'true',
      reply_markup: markup ? JSON.stringify(markup) : '' }, // тривога — завжди зі звуком
  })));
  // запам'ятовуємо повідомлення (адмін/чат), щоб при хибній тривозі прибрати їх
  if (a && a.id) {
    const p = PropertiesService.getScriptProperties(), key = 'SOS_NMSG_' + a.id;
    const list = JSON.parse(p.getProperty(key) || '[]');
    res.forEach((r, i) => { try { if (r.getResponseCode() === 200) list.push([ids[i], JSON.parse(r.getContentText()).result.message_id]); } catch (e) {} });
    p.setProperty(key, JSON.stringify(list.slice(-40)));
  }
  return res.filter(r => r.getResponseCode() === 200).length;
}

// Видалити повідомлення про тривогу в адміна й чаті ОСББ; forget — лише забути (тривогу закрито нормально)
function sosNotifyCleanup_(a, forget) {
  const p = PropertiesService.getScriptProperties(), key = 'SOS_NMSG_' + a.id;
  const list = JSON.parse(p.getProperty(key) || '[]');
  p.deleteProperty(key);
  if (forget || !list.length) return;
  UrlFetchApp.fetchAll(list.map(x => ({ url: tgUrl_('deleteMessage'), method: 'post', muteHttpExceptions: true,
    payload: { chat_id: x[0], message_id: String(x[1]) } })));
}

// Натискання кнопок
function sosCallback_(cq) {
  const data = cq.data || '';
  const who = cq.from;
  const uid = String(who.id);
  const answer = text => tgCall_('answerCallbackQuery', { callback_query_id: cq.id, text: text || '' });
  if (data === 'sk:0') { answer(''); return sosContact_(uid); }
  if (/^sb:\d+$/.test(data)) { // адмін блокує тривоги від людини
    if (uid !== (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim()) return answer('Лише для адміністратора');
    sosBan_(data.slice(3), true);
    answer('Заблоковано');
    return tgCall_('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: '🚫 Заблоковано (/sosunban ' + data.slice(3) + ')', callback_data: 'sk:1' }]] } });
  }
  const m = data.match(/^s([gcdehxapy]):(\d+)(?::(\d+))?$/);
  if (!m) return answer('');
  const act = m[1], id = m[2], val = Number(m[3] || 0);

  const lock = sosLock_();
  if (!lock.tryLock(20000)) { answer('Бот зайнятий — натисніть ще раз за кілька секунд'); return; }
  let a, all, out = null;
  try {
    all = sosGet_();
    a = all[id];
    if (!a) { answer('Ця тривога вже закрита'); return; }
    const p = PropertiesService.getScriptProperties();
    const isAdmin = uid === (p.getProperty('TG_ADMIN_ID') || '').trim();
    const isStuck = uid === a.uid;
    if (act === 'h' && isStuck && val === 99) { out = 'rehouse'; }
    else if (act === 'h' && isStuck) { a.house = SOS.HOUSES[val - 1] || ''; out = 'house'; }
    else if (act === 'e' && isStuck) { a.ent = val; out = 'ent'; }
    else if (act === 'p' && isStuck) { // таблиця «будинок + підʼїзд»
      if (val) { a.house = SOS.HOUSES[Math.floor(val / 10) - 1] || ''; a.ent = val % 10; }
      out = 'ent';
    }
    else if (act === 'g') {
      if (isStuck && !a.test) { answer('Це ваша тривога'); return; }
      if (a.go.some(x => x.id === uid)) { answer('Ви вже йдете 👍'); return; }
      a.go.push({ id: uid, who: userLink_(who), name: firstName_(who) }); out = 'go';
      a.first = !a.firstGo; a.firstGo = true; // сусідам — про першого, хто йде
    } else if (act === 'c') {
      if (a.called) { answer('Аварійку вже викликали — дзвонити не потрібно'); return; }
      a.called = true; a.calledBy = userLink_(who); a.calledName = firstName_(who); a.calledId = uid; out = 'call';
      a.first = true; // виклик аварійки буває лише один — сусідам завжди
    } else if (act === 'y' && isStuck) { // «Так, я досі в ліфті»
      if (!a.pending) { answer('Тривогу вже розіслано'); return; }
      if (a.trust === 'flag' || a.trust === 'ban') { answer('Тривогу передано адміністратору'); return; }
      out = 'yconfirm';
    } else if (act === 'a' && isAdmin) {
      if (!a.pending) { answer('Тривогу вже розіслано'); return; }
      if (a.allSent) { answer('Ліміт тривог від цієї людини на сьогодні — розсилаю лише в чат'); }
      a.pending = false; a.tc = Date.now(); out = 'approve';
      a.massNow = !a.allSent; a.allSent = true;
    } else if (act === 'x') {
      if (!isStuck && !isAdmin) { answer('Скасувати може лише той, хто натиснув 🆘'); return; }
      delete all[id]; out = 'cancel'; a.doneBy = isStuck ? 'сам(а)' : userLink_(who);
      // хибна: позначив адмін або людина скасувала вже після розсилки → далі її тривоги лише вручну
      a.isFalse = !a.test && ((isAdmin && !isStuck) || (!a.pending && a.massDone));
    } else if (act === 'd') {
      const allowed = isStuck || isAdmin || a.go.some(x => x.id === uid);
      if (!allowed) { answer('Закрити тривогу може лише той, хто застряг, або той, хто йде допомогти'); return; }
      delete all[id]; out = 'done'; a.doneBy = isStuck ? 'сам(а)' : userLink_(who);
    } else { answer(''); return; }
    if (out !== 'done' && out !== 'cancel') all[id] = a;
    sosPut_(all);
  } finally { lock.releaseLock(); }

  const chatId = cq.message && cq.message.chat.id, msgId = cq.message && cq.message.message_id;
  if (out === 'yconfirm') {
    answer('Розсилаю сусідам…');
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId });
    sosAutoApprove_(a, 'confirm');
    return;
  }
  if (out === 'approve') {
    answer('Розсилаю сусідам…');
    if (!a.amsg) a.amsg = msgId;
    if (a.massNow) sosApprove_(a);
    else { // ліміт масових тривог: лише чат ОСББ
      sosNotify_('🆘 <b>ЗАСТРЯГЛИ В ЛІФТІ!</b> #' + a.id + '\n\n👤 ' + a.who + '\n📍 ' + sosPlace_(a), sosActions_(a.id), a);
    }
    return;
  }
  if (out === 'rehouse') {
    answer('');
    tgCall_('editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text: sosInstr_() +
      '\n\n📍 <b>Де ви?</b> Натисніть номер підʼїзду в рядку свого будинку:', reply_markup: sosUserKb_(a.id, 'house') });
  } else if (out === 'house') {
    answer(a.house ? 'Будинок ' + a.house : 'Пропущено');
    if (a.pending && a.amsg) tgCall_('editMessageText', { chat_id: (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim(),
      message_id: a.amsg, parse_mode: 'HTML', text: sosPendingText_(a), reply_markup: sosPendingKb_(a.id) });
    tgCall_('editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text: sosInstr_() +
      '\n\n📍 ' + sosPlace_(a) + '\nТепер оберіть підʼїзд:', reply_markup: sosUserKb_(a.id, 'ent') });
  } else if (out === 'ent') {
    answer('Дякуємо!');
    tgCall_('editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text: sosInstr_() +
      '\n\n📍 ' + sosPlace_(a) + '\n✅ Дякуємо! Ми напишемо, коли допомога буде в дорозі.',
      reply_markup: sosUserKb_(a.id, 'done') });
    if (a.pending && a.house && a.ent && a.trust === 'ok') { // адреса повна + довіра → одразу всім
      sosAutoApprove_(a, 'trust');
    } else if (a.pending) { // адмін ще не вирішив — оновлюємо його повідомлення
      if (a.amsg) tgCall_('editMessageText', { chat_id: (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim(),
        message_id: a.amsg, parse_mode: 'HTML', text: sosPendingText_(a), reply_markup: sosPendingKb_(a.id) });
    } else {
      sosNotify_('📍 Уточнення до тривоги #' + a.id + ': ' + sosPlace_(a) + '\n👤 ' + a.who, sosActions_(a.id), a);
      if (a.massDone && !a.test) sosAll_('📍 <b>Уточнення до тривоги в ліфті:</b> ' + sosPlace_(a), sosNeighbourKb_(a), a);
    }
    sosLog_(a, 'Місце', sosPlace_(a).replace(/<[^>]+>/g, ''));
  } else if (out === 'go') {
    answer('Дякуємо! Застряглого повідомлено');
    send_(a.uid, '✋ ' + userLink_(who) + ' <b>іде вам на допомогу</b>. Тримайтеся!', false, sosUserKb_(a.id, 'done'));
    sosLog_(a, 'Іде допомогти', userLink_(who).replace(/<[^>]+>/g, ''));
    sosReacted_(a, '✋ <b>' + esc_(firstName_(who)) + '</b> іде допомогти', userLink_(who) + ' іде допомогти', uid);
  } else if (out === 'call') {
    answer('Позначено');
    send_(a.uid, '📞 <b>Аварійну службу ліфтів викликано.</b> Допомога в дорозі.', false, sosUserKb_(a.id, 'done'));
    sosLog_(a, 'Викликали аварійку', a.calledBy.replace(/<[^>]+>/g, ''));
    sosReacted_(a, '📞 <b>' + esc_(a.calledName) + '</b> викликав(ла) аварійку', a.calledBy + ' викликав(ла) аварійку', uid);
  } else if (out === 'cancel') {
    answer('Тривогу скасовано');
    let note = ', сусідам вона не надходила.';
    if (a.pending) { // ще не підтверджено — нікому, крім адміна, нічого не йшло
      sosNotifyCleanup_(a, true);
      if (a.amsg) tgCall_('editMessageText', { chat_id: (PropertiesService.getScriptProperties().getProperty('TG_ADMIN_ID') || '').trim(),
        message_id: a.amsg, parse_mode: 'HTML', text: sosPendingText_(a).replace(/\n\n⏸[\s\S]*$/, '') +
          '\n\n❌ <b>Скасовано</b> (' + a.doneBy + '). Сусідам і в чат нічого не надсилали.' });
    } else {
      sosNotifyCleanup_(a); // прибираємо тривогу з чату ОСББ і в адміна
      sosAdmin_('❌ Тривогу #' + a.id + ' <b>скасовано</b> — хибна тривога (' + a.doneBy + '). Повідомлення про неї в чаті видалено.');
      if (a.allSent && a.massDone && !a.test) {
        // прибираємо тривогу з чатів сусідів; кому вже відгукнувся — пишемо особисто
        const del = a.massLog ? undoDeleteById_(a.massLog) : null;
        const bye = 'ℹ️ <b>Відбій тривоги</b> (' + sosPlace_(a) + '): кнопку натиснули випадково, допомога не потрібна. Дякуємо за небайдужість!';
        if (del) {
          a.go.map(x => x.id).concat(a.calledId ? [a.calledId] : []).filter((x, i, arr) => arr.indexOf(x) === i)
            .forEach(x => send_(x, bye));
          note = ' — повідомлення в сусідів видалено.';
        } else { sosAll_(bye, null, a); note = ' — сусідам повідомлено, що допомога не потрібна.'; }
      }
    }
    if (chatId) tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId }); // прибираємо кнопки з натиснутого повідомлення
    send_(a.uid, '👌 Тривогу #' + a.id + ' <b>скасовано</b>. Нічого страшного' + note, false, keyboardFor_(a.uid));
    if (a.isFalse) {
      const p = PropertiesService.getScriptProperties();
      const fl = JSON.parse(p.getProperty('SOS_FALSE') || '{}');
      fl[a.uid] = (fl[a.uid] || 0) + 1;
      p.setProperty('SOS_FALSE', JSON.stringify(fl));
      sosAdmin_('🛡 ' + a.who + ': хибних тривог — ' + fl[a.uid] + '. Наступні тривоги від цієї людини йтимуть лише через вас.' +
        '\nЗняти позначку: /sosunban ' + a.uid, { inline_keyboard: [[{ text: '🚫 Заблокувати тривоги від неї', callback_data: 'sb:' + a.uid }]] });
    }
    sosLog_(a, 'Скасовано', a.pending ? 'до розсилки' : 'хибна тривога');
  } else if (out === 'done') {
    answer('Тривогу закрито ✅');
    send_(a.uid, '✅ <b>Раді, що все гаразд!</b> Тривогу #' + a.id + ' закрито.', false, keyboardFor_(a.uid));
    const doneText = '✅ Тривогу #' + a.id + ' закрито — людину звільнили (' + a.doneBy + '). Дякуємо всім, хто відгукнувся!';
    sosNotify_(doneText, null, a);
    if (a.allSent && a.massDone && !a.test) sosAll_('✅ Тривогу в ліфті (' + sosPlace_(a) + ') закрито — людину звільнили. Дякуємо всім, хто відгукнувся!', null, a);
    sosNotifyCleanup_(a, true);
    sosLog_(a, 'Звільнили', a.doneBy.replace(/<[^>]+>/g, '') + ', ' + fmtDur_(Date.now() - a.t));
  }
}

// Щохвилини: ескалація, нагадування, автозакриття
function sosTick_() {
  const raw = PropertiesService.getScriptProperties().getProperty('SOS_ACTIVE');
  if (!raw || raw === '{}') return;
  const lock = sosLock_();
  if (!lock.tryLock(10000)) return;
  const todo = [];
  try {
    const all = sosGet_();
    const now = Date.now();
    Object.keys(all).forEach(k => {
      const a = all[k], age = (now - a.t) / 60000;
      if (a.pending) { // адмін ще не вирішив: сусідам нічого не йде
        if (age >= SOS.CLOSE_MIN) { delete all[k]; todo.push(['close', a]); return; }
        if (SOS.AUTO_SEND_MIN > 0 && age >= SOS.AUTO_SEND_MIN) {
          a.pending = false; a.tc = now; if (!a.allSent) { a.allSent = true; todo.push(['auto', a]); }
        } else if (!a.arem && age >= SOS.ADMIN_REMIND_MIN) { a.arem = true; todo.push(['arem', a]); if (a.trust !== 'flag') todo.push(['askc', a]); }
        if (!a.ask && age >= SOS.ASK_MIN) { a.ask = true; todo.push(['ask', a]); }
        return;
      }
      const ageC = (now - (a.tc || a.t)) / 60000; // від підтвердження
      if (age >= SOS.CLOSE_MIN) { delete all[k]; todo.push(['close', a]); return; }
      if (!a.allSent && ageC >= SOS.ALL_AFTER_MIN) { a.allSent = true; todo.push(['mass', a]); }
      if (!a.esc && !a.go.length && !a.called && ageC >= SOS.ESCALATE_MIN) { a.esc = true; todo.push(['esc', a]); }
      if (!a.ask && age >= SOS.ASK_MIN) { a.ask = true; todo.push(['ask', a]); }
    });
    sosPut_(all);
  } finally { lock.releaseLock(); }

  todo.forEach(([what, a]) => {
    if (what === 'askc') {
      send_(a.uid, '❓ <b>Ви досі в ліфті?</b>\nЯкщо так — натисніть кнопку, і тривогу отримають сусіди та чат будинку.',
        false, { inline_keyboard: [[{ text: '🆘 Так, я досі в ліфті', callback_data: 'sy:' + a.id }],
          [{ text: '✅ Ні, вже вийшов(ла)', callback_data: 'sd:' + a.id }]] });
    } else if (what === 'arem') {
      sosAdmin_('⏰ <b>Тривога #' + a.id + ' чекає вашого рішення</b>' + (a.test ? ' <i>(тест)</i>' : '') + ' (' + SOS.ADMIN_REMIND_MIN + ' хв)\n📍 ' + sosPlace_(a) +
        '\n👤 ' + a.who, sosPendingKb_(a.id));
    } else if (what === 'auto') {
      sosApprove_(a, true);
    } else if (what === 'mass') {
      sosMass_(a);
    } else if (what === 'esc') {
      const text = '🆘 <b>Потрібна допомога!</b>' + (a.test ? ' <i>(тест)</i>' : '') +
        ' Сусід(ка) застряг(ла) в ліфті: ' + sosPlace_(a) + '.\n\nЯкщо ви поруч — підійдіть, будь ласка, або викличте аварійку' +
        (liftPhone_() ? ': ' + esc_(liftPhone_()) : '') + '.';
      sosNotify_('⏰ <b>Ніхто ще не відгукнувся</b> на тривогу #' + a.id + ' (' + SOS.ESCALATE_MIN + ' хв)!\n\n' + text, sosActions_(a.id), a);
      sosLog_(a, 'Нагадування', 'ніхто не відгукнувся');
    } else if (what === 'ask') {
      send_(a.uid, 'Вас уже звільнили? Якщо так — натисніть кнопку нижче.\n\n' + sosInstr_(), false, sosUserKb_(a.id, 'done'));
    } else if (what === 'close') {
      sosNotifyCleanup_(a, true);
      sosLog_(a, 'Автозакриття', 'через ' + SOS.CLOSE_MIN + ' хв');
    }
  });
}

// Тривога всім підписникам (тест — лише адміну)
function sosMass_(a) {
  const ph = liftPhone_();
  const cur = sosGet_()[a.id] || a; // свіжий стан: можливо, хтось уже йде / викликав
  let text = '🆘 <b>ЗАСТРЯГЛИ В ЛІФТІ!</b>' + (a.test ? ' <i>(тест)</i>' : '') + '\n\n📍 ' + sosPlace_(cur) + '\n🕐 ' + hhmm_(new Date(a.t));
  if (cur.go.length) text += '\n\n✋ Уже йде: <b>' + cur.go.map(x => esc_(x.name || 'сусід')).join(', ') + '</b>';
  if (cur.called) text += '\n📞 Аварійку <b>вже викликано</b> — повторно дзвонити не потрібно.';
  if (!cur.go.length) text += '\n\nЯкщо ви поруч — підійдіть, будь ласка, і натисніть «✋ Я йду допомогти», щоб людина та інші сусіди знали, що допомога в дорозі.';
  if (!cur.called) text += '\n\nЯкщо телефонуєте в аварійку — натисніть «📞 Викликав аварійку», щоб інші не дзвонили вдруге.' +
    (ph ? '\n📞 Аварійка ліфтів: ' + esc_(ph) : '') + '\n' + SOS_RAID_NOTE;
  text += sosPrefNote_();
  const kb = sosNeighbourKb_(cur);
  if (a.test) { sosNotify_(text + '\n\n<i>(у тесті це повідомлення бачите лише ви, а насправді — сусіди за їхніми налаштуваннями)</i>', kb, a); }
  let logId = '';
  if (!a.test) {
    // позначаємо заздалегідь: якщо хтось відгукнеться, поки триває розсилка, сусіди теж отримають оновлення
    const lk = sosLock_(); lk.waitLock(10000);
    try { const all0 = sosGet_(); if (all0[a.id]) { all0[a.id].massDone = true; sosPut_(all0); } } finally { lk.releaseLock(); }
    const rr = sosAll_(text, kb, a); logId = recordBroadcast_('SOS #' + a.id, text, rr); statDelivered_('🆘 Тривоги', rr.n);
  }
  // позначаємо, що масову тривогу розіслано (для «закрито» всім і щоб хибну тривогу можна було видалити)
  const lock = sosLock_();
  lock.waitLock(10000);
  try { const all = sosGet_(); if (all[a.id]) { all[a.id].massDone = true; all[a.id].massLog = logId; sosPut_(all); } a.massDone = true; a.massLog = logId; }
  finally { lock.releaseLock(); }
  sosLog_(a, 'Тривога всім', a.test ? 'тест' : 'усім підписникам');
}

// Кому з сусідів іде тривога: за налаштуваннями (усі / мій будинок / вимкнено).
// Не надсилаємо застряглому та адміну/чату ОСББ (вони отримують окремі повідомлення).
function sosAudience_(a) {
  const skip = [a.uid].concat(sosRecipients_(a));
  return subsData_().filter(x => skip.indexOf(x.id) < 0 && x.mode !== 'off' &&
    !(x.mode === 'house' && x.house && a.house && x.house !== a.house)).map(x => x.id);
}

// Імʼя для повідомлень сусідам; якщо в імені лише невидимі символи / емодзі — @username або «Сусід»
function firstName_(u) {
  const clean = v => String(v || '').replace(/[\u200B-\u200F\u2060-\u206F\u3164\uFEFF\u115F\u1160\u00AD]/g, '').trim();
  const fn = clean(u && [u.first_name, u.last_name].filter(Boolean).join(' '));
  if (/[\p{L}\p{N}]/u.test(fn)) return fn.slice(0, 30);
  if (u && u.username) return '@' + u.username;
  return 'Сусід';
}

function sosPrefNote_() { return '\n\n<i>⚙️ Тривоги лише з вашого будинку або вимкнути — /settings</i>'; }

// Кнопки для сусідів: лише ті дії, які ще ніхто не зробив
function sosNeighbourKb_(a) {
  const rows = [];
  if (!a.go.length) rows.push([{ text: '✋ Я йду допомогти', callback_data: 'sg:' + a.id }]);
  if (!a.called) rows.push([{ text: '📞 Викликав аварійку', callback_data: 'sc:' + a.id }]);
  return rows.length ? { inline_keyboard: rows } : null;
}

// Перша реакція (іде / викликав аварійку) — ОДНЕ повідомлення всім: сусідам, у чат ОСББ і адміну.
// Наступні реакції — лише адміну, щоб не спамити.
function sosReacted_(a, publicLine, adminLine, actorId) {
  if (!a.first) {
    sosAdmin_('➕ ' + adminLine + ' (тривога #' + a.id + ')');
    return;
  }
  const isCall = /аварійку/.test(publicLine);
  const text = '✅ <b>На тривогу вже відреагували</b>' + (a.test ? ' <i>(тест)</i>' : '') + '\n📍 ' + sosPlace_(a) +
    '\n\n' + publicLine + '.\n' + (isCall ? 'Телефонувати в аварійку більше не потрібно' : 'Іти більше не потрібно') +
    (isCall && !a.go.length ? '. Якщо ви поруч — підійдіть до людини, натиснувши «✋ Я йду допомогти» в тривозі.' : ' — дякуємо!');
  sosNotify_(text, null, a);                       // адмін + чат ОСББ (поки тривога не розіслана — лише адмін)
  if (a.massDone && !a.test) sosAll_(text, null, a, [actorId]); // сусіди, які отримали тривогу
}

// (не використовується) Оновлення для сусідів: «вже йдуть» / «аварійку вже викликали» — щоб не дублювали дії та дзвінки
function sosUpdate_(a, what, actorId) {
  if (!a.massDone && !a.test) return; // масову тривогу ще не розіслано — її текст уже врахує стан
  let text;
  if (what === 'go') {
    text = '✋ <b>Допомога вже йде!</b>\n📍 ' + sosPlace_(a) + '\n\n<b>' + esc_(a.go[0].name) + '</b> іде до людини в ліфті. ' +
      'Якщо ви не поруч — іти не потрібно, дякуємо!' +
      (a.called ? '\n📞 Аварійку теж уже викликано.' : '\n\n📞 Аварійку ще ніхто не позначив. Якщо телефонуєте — натисніть кнопку нижче, щоб інші не дзвонили вдруге.');
  } else {
    text = '📞 <b>Аварійку ліфтів уже викликано</b> (' + esc_(a.calledName || 'сусід') + ').\n📍 ' + sosPlace_(a) +
      '\n\nПовторно телефонувати не потрібно.' +
      (a.go.length ? '' : '\nЯкщо ви поруч — підійдіть до людини та натисніть «✋ Я йду допомогти».');
  }
  const kb = sosNeighbourKb_(a);
  if (a.test) sosNotify_(text + '\n\n<i>(тест: так побачать сусіди)</i>', kb, a);
  else sosAll_(text, kb, a, [actorId]);
}

// Розсилка сусідам (вдень — зі звуком, вночі — без)
function sosAll_(html, markup, a, skipIds) {
  const ids = sosAudience_(a).filter(x => !(skipIds || []).includes(x));
  const base = { text: html, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: isNight_() };
  if (markup) base.reply_markup = markup;
  return massSend_(ids, 'sendMessage', base);
}

// Контакт-картка аварійки (зберігається в телефонну книгу одним дотиком — для дзвінка без інтернету)
function sosContact_(chatId) {
  const phs = liftPhones_();
  if (!phs.length) return send_(chatId, 'Номер аварійки ліфтів ще не налаштовано. Екстрені служби: 101 / 112.');
  phs.forEach((ph, i) => tgCall_('sendContact', { chat_id: chatId, phone_number: ph,
    first_name: 'Аварійка ліфтів' + (phs.length > 1 ? ' ' + (i + 1) : ''), last_name: CFG.NAME }));
  send_(chatId, '☝️ Збережіть ' + (phs.length > 1 ? 'ці контакти' : 'цей контакт') + ' — тоді зможете зателефонувати навіть без інтернету.',
    false, keyboardFor_(String(chatId)));
}

// ===== Журнал тривог (лист «SOS») =====
function sosLog_(a, event, details) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('SOS');
  if (!sh) { sh = ss.insertSheet('SOS'); sh.appendRow(['Дата', 'Час', '#', 'Подія', 'Хто застряг', 'Місце', 'Деталі']); sh.setFrozenRows(1); }
  const now = new Date();
  sh.appendRow([Utilities.formatDate(now, CFG.TZ, 'dd.MM.yyyy'), hhmm_(now), a.id, event,
    a.who.replace(/<[^>]+>/g, ''), sosPlace_(a).replace(/<[^>]+>/g, ''), details || '']);
}


// ===== Графік: скинути збережене й перечитати канал (запустити вручну один раз після зміни джерела) =====
function resetSchedule() {
  const p = PropertiesService.getScriptProperties();
  ['SCHED_DAYS', 'SCHED_SEEN', 'SCHED_SENT', 'SCHED_SENT_AT', 'SCHED_LAST', 'SCHED_AT', 'REMIND_SENT'].forEach(k => p.deleteProperty(k));
  pollSchedule_(); // перший прохід лише запам'ятовує графіки, без розсилки
  console.log('Графік перечитано з каналу. Так зараз виглядає /grafik:\n\n' + lastSchedText_());
}

// Розіслати всім уточнений графік на сьогодні й завтра (після resetSchedule, якщо раніше пішов неправильний)
function sendScheduleNow() {
  const text = lastSchedText_();
  if (!/Графік/.test(text)) return console.log('Графіка ще немає: ' + text);
  const n = broadcast_('🔄 <b>Уточнений графік</b> — попередній був для іншої черги, вибачте за плутанину.\n\n' + text);
  console.log('Розіслано: ' + n);
}


// ===== Перевірка черги: порівнює графіки груп із каналів ДТЕК із графіком СвітлоБота (нічого не розсилає) =====
// Запустіть checkGroups і подивіться журнал: група, у якої дати збігаються з СвітлоБотом, — ваша.
function checkGroups(days) {
  days = Number(days) || 7;
  const GROUPS = ['4.1', '4.2', '5.1', '5.2'];
  const DTEK = [
    { name: 'kyivsvitlo_dtek', mustHave: /Київщин/i },
    { name: 'svitlokyivregiondtek', mustHave: null },
    { name: 'BorshchagovkaNews', mustHave: /Київськ\S*\s+обл|Київщин/i },
    { name: 'kiev_svet', mustHave: /Київськ\S*\s+обл|Київщин/i, mustNot: /м\.\s*Київ\b|у\s+Києві|для\s+Києва|столиц/i },
  ];
  const fmt = sl => sl.length ? sl.map(x => x.join('–')).join(', ') : 'без відключень';
  // графік СвітлоБота (за адресою ЖК) по датах — останній пост на кожну дату
  const ref = {};
  channelPostsDeep_(CFG.SIGNAL_CHANNEL, days).forEach(p => { const s = svitlobotSched_(p.text); if (s) ref[s.date] = s.slots; });
  console.log('Період: останні ' + days + ' дн.\nСвітлоБот (адреса ЖК):\n  ' + Object.keys(ref).map(d => d + ': ' + fmt(ref[d])).join('\n  '));
  // пости каналів ДТЕК читаємо один раз
  const posts = [];
  DTEK.forEach(ch => { try { channelPostsDeep_(ch.name, days).forEach(p => posts.push(Object.assign(p, { ch: ch }))); } catch (e) { console.log('@' + ch.name + ': ' + e); } });
  console.log('Постів у каналах ДТЕК: ' + posts.length + ', найсвіжіший: ' +
    (posts.length ? Utilities.formatDate(new Date(Math.max.apply(null, posts.map(p => p.time))), CFG.TZ, 'dd.MM HH:mm') : '—'));
  const keep = SCHED.GROUP;
  GROUPS.forEach(g => {
    SCHED.GROUP = g;
    const gd = {};
    posts.filter(p => isSchedPost_(p, p.ch)).sort((a, b) => a.time - b.time)
      .forEach(p => { const s = parseSched_(p.text); if (s && s.date !== '?') gd[s.date] = s.slots; });
    const key = d => d.slice(3) + d.slice(0, 2); // 'dd.MM' → 'MMdd' для сортування
    const common = Object.keys(gd).filter(d => ref[d]).sort((x, y) => key(x) < key(y) ? -1 : 1);
    const same = common.filter(d => JSON.stringify(gd[d]) === JSON.stringify(ref[d]));
    console.log('\nГрупа ' + g + ': збіг із СвітлоБотом ' + same.length + ' з ' + common.length + ' спільних дат' +
      (common.length && same.length === common.length ? '  ✅ СХОЖЕ, ЦЕ ВАША ЧЕРГА' : '') + '\n  ' +
      (common.concat(Object.keys(gd).filter(d => !ref[d]).slice(-2)).map(d => d + ': ' + fmt(gd[d]) + (ref[d] ? (JSON.stringify(gd[d]) === JSON.stringify(ref[d]) ? ' ✅' : ' ❌') : '  (у СвітлоБота немає)')).join('\n  ') || 'графіків не знайдено'));
  });
  SCHED.GROUP = keep;
}
