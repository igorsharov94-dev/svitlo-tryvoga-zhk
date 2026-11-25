// «Світло ЖК» — посередник між Telegram і Google Apps Script (Cloudflare Worker) + масова розсилка
// Для кожного ЖК — окремий Worker і окремий бот.
// 1) Вставте сюди адресу веб-застосунку Apps Script цього бота (закінчується на /exec):
const GAS_URL = 'https://script.google.com/macros/s/ВАШ_ID_ВЕБЗАСТОСУНКУ/exec';
// 2) У Cloudflare: Settings → Variables and Secrets → Add → тип Secret, назва SEND_KEY, значення — ваш секретний ключ
//    (той самий, що у властивості скрипта CF_KEY цього бота; для кожного ЖК — свій).
// 3) Settings → Triggers → Cron: * * * * * (щохвилини читає канал Світлобота)

const ALLOWED = ['sendMessage', 'sendPhoto', 'forwardMessage', 'copyMessage', 'deleteMessage', 'editMessageText'];
const MAX_IDS = 45;     // безкоштовний план Cloudflare — до 50 запитів за один виклик
const WAVE = 25;        // скільки повідомлень одночасно (ліміт Telegram ~30/с)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/go/')) return go(request, url, env, ctx);
    if (request.method === 'POST' && url.pathname === '/send') return sendMany(request, env);
    if (request.method !== 'POST') return new Response('ok');
    // Вебхук Telegram: одразу відповідаємо «ок», а оновлення передаємо в скрипт у фоні
    const body = await request.text();
    ctx.waitUntil(fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      redirect: 'follow',
    }));
    return new Response('ok');
  },

  // Щохвилини (Settings → Triggers → Cron: * * * * *) — запускає перевірку світла в Apps Script.
  // Так перевірки не витрачають 90-хвилинний добовий ліміт таймерів Google.
  async scheduled(event, env, ctx) {
    if (!env.SEND_KEY) return;
    ctx.waitUntil(fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cf_tick: env.SEND_KEY }),
      redirect: 'follow',
    }));
  },
};

// Розсилка пачки: { key, token, method, ids: [...], payload: {...}, items?: [{chat_id, ...}] }
//   → { ok, results: [{id, code, mid}] }   (mid — номер повідомлення, щоб потім можна було видалити)
async function sendMany(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
  if (!env.SEND_KEY || b.key !== env.SEND_KEY) return new Response('forbidden', { status: 403 });
  if (!ALLOWED.includes(b.method) || !Array.isArray(b.ids) || !b.token) return new Response('bad request', { status: 400 });
  const items = (Array.isArray(b.items) ? b.items : b.ids.map(id => ({ chat_id: id }))).slice(0, MAX_IDS);
  const results = [];
  for (let i = 0; i < items.length; i += WAVE) {
    const part = items.slice(i, i + WAVE);
    const res = await Promise.all(part.map(it => sendOne(b.token, b.method, Object.assign({}, b.payload || {}, it))));
    part.forEach((it, j) => results.push({ id: it.chat_id, code: res[j].code, mid: res[j].mid }));
    if (i + WAVE < items.length) await sleep(1000);
  }
  return Response.json({ ok: true, results: results });
}

async function sendOne(token, method, payload) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    let mid;
    if (r.status === 200) { try { const j = await r.json(); mid = j.result && j.result.message_id; } catch (e) {} }
    return { code: r.status, mid: mid }; // 429 і помилки скрипт дошле сам напряму
  } catch (e) {
    return { code: 0 };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Перехід за посиланням з лічильником: /go/<мітка>?u=<адреса>&s=<підпис>
// Підпис (HMAC з SEND_KEY) не дає підставити чуже посилання. Перехід рахується в Apps Script (аркуш «Переходи»).
async function go(request, url, env, ctx) {
  const slug = url.pathname.slice(4).replace(/[^a-z0-9-]/gi, '').slice(0, 30);
  const u = url.searchParams.get('u') || '', s = url.searchParams.get('s') || '';
  let target = '';
  try {
    const b64 = u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((u.length + 3) % 4);
    target = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  } catch (e) {}
  if (!/^https?:\/\//.test(target) || !env.SEND_KEY || (await hmac16(env.SEND_KEY, slug + '|' + target)) !== s)
    return new Response('Посилання недійсне', { status: 400 });
  const ua = request.headers.get('user-agent') || '';
  if (!/bot|crawl|spider|preview/i.test(ua)) { // попередній перегляд посилань не рахуємо
    const day = new Date().toISOString().slice(0, 10);
    const visitor = (await sha256hex((request.headers.get('cf-connecting-ip') || '') + '|' + ua + '|' + day)).slice(0, 12);
    ctx.waitUntil(fetch(GAS_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cf_click: env.SEND_KEY, slug: slug, v: visitor }), redirect: 'follow',
    }));
  }
  return Response.redirect(target, 302);
}

async function hmac16(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}