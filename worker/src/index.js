// Baldwin Plan — only members of the DingTalk organization can see the page.
// Flow: "/" serves a tiny bootstrap page (no data) that asks DingTalk for a one-time
// login code; /auth checks that code with DingTalk and sets a short session cookie;
// everything under /app/ (the plan and its images) is served only with a valid cookie.

const SESSION_MIN = 15; // cookie lifetime; every new open of the app checks DingTalk again
const enc = new TextEncoder();

const BOOT = (corpId) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Baldwin Plan</title>
<style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f6efe4;color:#3a2a22;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}
p{font-size:16px;line-height:1.5}</style></head><body><div><p id="m">Loading…</p></div>
<script src="https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js"></script>
<script>
const m=document.getElementById('m');
function fail(t){m.innerHTML=t;}
if(!window.dd||dd.env.platform==='notInDingTalk'){fail('Please open Baldwin Plan from DingTalk → Workplace.<br>请在钉钉「工作台」里打开。');}
else{
 dd.ready(function(){
  dd.runtime.permission.requestAuthCode({corpId:${JSON.stringify(corpId)},
   onSuccess:function(r){
    fetch('/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:r.code}),credentials:'same-origin'})
     .then(function(x){return x.json()}).then(function(j){
       if(j.ok){location.replace('/app/'+location.search);}else{fail('No access. Please ask your manager to add you to the team in DingTalk.<br>没有权限，请联系管理员。');}
     }).catch(function(){fail('Network error — please try again.');});
   },
   onFail:function(){fail('DingTalk login failed — please close and reopen.');}
  });
 });
}
</script></body></html>`;

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

async function readSession(req, env) {
  const c = (req.headers.get('cookie') || '').match(/(?:^|;\s*)bp=([^;]+)/);
  if (!c) return null;
  const [body, sig] = c[1].split('.');
  if (!body || !sig || sig !== (await hmac(env.SESSION_KEY, body))) return null;
  try {
    const s = JSON.parse(unb64(body));
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}

let tokenCache = { v: null, exp: 0 };
async function accessToken(env) {
  if (tokenCache.v && tokenCache.exp > Date.now()) return tokenCache.v;
  const r = await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(env.APP_KEY)}&appsecret=${encodeURIComponent(env.APP_SECRET)}`);
  const j = await r.json();
  if (j.errcode !== 0) throw new Error('gettoken ' + j.errcode);
  tokenCache = { v: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return j.access_token;
}

// Managers: DingTalk admins, plus anyone whose first name is in MANAGERS (wrangler.toml).
function isManager(env, sys, name) {
  if (sys === true) return true;
  const first = String(name).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  return !!first && String(env.MANAGERS || '').toLowerCase().split(',').map((x) => x.trim()).includes(first);
}

class Me {
  constructor(s) { this.s = s; }
  element(el) {
    const me = JSON.stringify({ n: this.s.n, m: this.s.m ? 1 : 0 }).replace(/</g, '\\u003c');
    el.prepend(`<script>window.__ME=${me};</script>`, { html: true });
  }
}

// Check-off writes go through here so we know who is ticking. Staff: only tasks assigned to them. Managers: any task.
const firstName = (x) => String(x).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
async function checkoff(req, env) {
  const s = await readSession(req, env);
  if (!s) return Response.json({ ok: false, error: 'login' }, { status: 401 });
  let b; try { b = await req.json(); } catch { return Response.json({ ok: false, error: 'bad' }, { status: 400 }); }
  const staffAction = ['done', 'notdone', 'clear'].includes(b.action);
  if (!staffAction && !['check', 'uncheck'].includes(b.action)) return Response.json({ ok: false, error: 'bad' }, { status: 400 });
  if (staffAction && !s.m) {
    const names = String(b.assigned || '').replace(/start of dinner/g, '').split('+').map(firstName).filter(Boolean);
    if (!names.includes(firstName(s.n))) return Response.json({ ok: false, error: 'notyours' }, { status: 403 });
  }
  const body = { key: b.key, date: b.date, role: b.role, task: b.task, assigned: b.assigned, action: b.action };
  if (b.note != null) body.note = String(b.note).slice(0, 200);
  if (b.code != null) body.code = String(b.code);
  body.by = s.n;
  const r = await fetch(env.SHEET_API, { method: 'POST', body: JSON.stringify(body) });
  return new Response(await r.text(), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

class PrivacyNote {
  element(el) {
    el.append(`<p style="margin:28px auto 90px;max-width:640px;padding:0 16px;text-align:center;font:400 11px/1.5 system-ui,-apple-system,sans-serif;color:#9a8b7d">🔒 Privacy notice: DailyPlan records your name and the time you open it, so managers can make sure everyone has seen the day's plan. Only managers can see these records, and they are deleted after 31 days.</p>`, { html: true });
  }
}

class ViewsButton {
  element(el) {
    el.append(`<a href="/app/views" style="position:fixed;right:14px;bottom:calc(64px + env(safe-area-inset-bottom,0px));z-index:2147483646;background:#8f1d21;color:#fff;font:600 14px/1 system-ui,sans-serif;padding:12px 16px;border-radius:999px;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25)">👀 Views</a>`, { html: true });
  }
}

class MgrButton {
  element(el) {
    el.append(`<a href="/app/?view=manager" style="position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483646;background:#1d1d1f;color:#f7f7f4;font:600 14px/1 system-ui,sans-serif;padding:12px 16px;border-radius:999px;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25)">📊 Manager</a>`, { html: true });
  }
}


// ---------- Who opened DailyPlan (kept 31 days; only name, user id and time) ----------
async function logOpen(env, uid, name) {
  const now = new Date();
  const key = 'open:' + torontoDate(now);
  const arr = JSON.parse((await env.BOT.get(key)) || '[]');
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  arr.push({ u: uid, n: name, t });
  await env.BOT.put(key, JSON.stringify(arr), { expirationTtl: 31 * 86400 });
}

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fn = (x) => String(x).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
const sameName = (a, b) => { a = fn(a); b = fn(b); return !!a && !!b && (a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)))); };

async function scheduledNames(env, origin, date) {
  try {
    const html = await (await env.ASSETS.fetch(new Request(origin + '/app/'))).text();
    const i = html.indexOf(`'${date}':{title`);
    if (i < 0) return null;
    let j = html.indexOf(":{title", i + 20); j = j < 0 ? html.length : j;
    const block = html.slice(html.indexOf('team:[', i), j);
    const names = new Set();
    for (const m of block.matchAll(/\['([^'\]]+?)','[0-9]/g)) names.add(m[1].replace(/[^\p{L}\p{N}. ]/gu, '').trim());
    return [...names].filter(Boolean);
  } catch { return null; }
}

async function viewsPage(env, url) {
  const today = torontoDate();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : today;
  const log = JSON.parse((await env.BOT.get('open:' + date)) || '[]');
  const people = new Map();
  for (const e of log) { const p = people.get(e.u) || { n: e.n, times: [] }; p.times.push(e.t); people.set(e.u, p); }
  const opened = [...people.values()].sort((a, b) => a.times[0].localeCompare(b.times[0]));
  const sched = await scheduledNames(env, url.origin, date);
  const notYet = sched ? sched.filter((s) => !opened.some((p) => sameName(p.n, s))) : null;
  const days = [];
  for (let k = 0; k < 7; k++) { const d = torontoDate(new Date(Date.now() - k * 86400000)); days.push(d); }
  const rows = opened.map((p) => `<tr><td>${esc(p.n)}</td><td>${esc(p.times[0])}</td><td>${p.times.length}</td></tr>`).join('') || '<tr><td colspan="3" class="mut">No one yet</td></tr>';
  const nope = notYet == null ? '<p class="mut">No schedule found for this day on the page.</p>' : notYet.length ? `<p>${notYet.map((x) => `<span class="chip">${esc(x)}</span>`).join(' ')}</p>` : '<p class="mut">Everyone on the schedule has opened it ✅</p>';
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Who opened DailyPlan</title>
<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#f6efe4;color:#2b211c}h1{font-size:20px;margin:4px 0 12px}h2{font-size:15px;margin:20px 0 8px}
.days a{display:inline-block;margin:0 6px 6px 0;padding:6px 10px;border-radius:999px;background:#fff;color:#2b211c;text-decoration:none;font-size:13px;border:1px solid #e3d6c3}.days a.on{background:#8f1d21;color:#fff;border-color:#8f1d21}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}td,th{padding:9px 10px;border-bottom:1px solid #f0e7da;text-align:left;font-size:14px}th{font-size:12px;color:#7a6a5c;font-weight:600}
.chip{display:inline-block;margin:0 6px 6px 0;padding:5px 10px;border-radius:999px;background:#fbe3d6;color:#8f1d21;font-size:13px}.mut{color:#7a6a5c;font-size:13px}a.back{color:#8f1d21;font-size:14px}</style></head><body>
<a class="back" href="/app/">← Back to plan</a><h1>👀 Who opened DailyPlan</h1>
<div class="days">${days.map((d) => `<a href="?date=${d}" class="${d === date ? 'on' : ''}">${d === today ? 'Today' : d.slice(5)}</a>`).join('')}</div>
<h2>On the schedule but not opened yet</h2>${nope}
<h2>Opened (${opened.length})</h2><table><tr><th>Name</th><th>First open</th><th>Times</th></tr>${rows}</table>
<p class="mut">Times are Toronto time. Records are kept for 31 days.</p></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } });
}

async function auth(req, env) {
  let code;
  try { code = (await req.json()).code; } catch {}
  if (!code) return Response.json({ ok: false }, { status: 400 });
  try {
    const t = await accessToken(env);
    const r = await fetch(`https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${t}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const j = await r.json();
    if (j.errcode !== 0 || !j.result || !j.result.userid) return Response.json({ ok: false }, { status: 403 });
    const name = j.result.name || '';
    const body = b64(JSON.stringify({ u: j.result.userid, n: name, m: isManager(env, j.result.sys, name) ? 1 : 0, exp: Date.now() + SESSION_MIN * 60000 }));
    const cookie = `bp=${body}.${await hmac(env.SESSION_KEY, body)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MIN * 60}`;
    await logOpen(env, j.result.userid, name).catch(() => {});
    return Response.json({ ok: true }, { headers: { 'set-cookie': cookie, 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ ok: false, err: 'server' }, { status: 502 });
  }
}

class Watermark {
  constructor(name) { this.name = name; }
  element(el) {
    const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric' });
    const txt = (this.name + ' · ' + d).replace(/[<>&"']/g, '');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='260' height='150'><text x='10' y='90' transform='rotate(-24 130 75)' font-family='sans-serif' font-size='16' fill='rgba(60,40,30,0.10)'>${txt}</text></svg>`;
    el.append(`<div aria-hidden="true" style="position:fixed;inset:0;z-index:2147483647;pointer-events:none;background-image:url(&quot;data:image/svg+xml;utf8,${encodeURIComponent(svg)}&quot;)"></div>`, { html: true });
  }
}


// ---------- Group robot (DailyPlan app robot) ----------
const REMINDER = {
  title: 'Reminder: Time-off requests close TONIGHT at 23:59!',
  text: [
    '### Reminder: Time-off requests close TONIGHT at 23:59! 🕛',
    '⏰ Need a day off? Submit your time-off request in **Sling** by **11:59 PM tonight**.',
    '✅ We’ll approve on-time requests where staffing allows.',
    '⚠️ Late requests may not be approved. If you miss the cutoff and get scheduled, please arrange a shift swap.',
    'Thanks! 🙌',
  ].join('\n\n'),
};

let newTokenCache = { v: null, exp: 0 };
async function newAccessToken(env) {
  if (newTokenCache.v && newTokenCache.exp > Date.now()) return newTokenCache.v;
  const r = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: env.APP_KEY, appSecret: env.APP_SECRET }),
  });
  const j = await r.json();
  if (!j.accessToken) throw new Error('accessToken ' + JSON.stringify(j));
  newTokenCache = { v: j.accessToken, exp: Date.now() + (j.expireIn - 300) * 1000 };
  return j.accessToken;
}

async function sendToGroups(env, msg) {
  const groups = JSON.parse((await env.BOT.get('groups')) || '{}');
  const t = await newAccessToken(env);
  const out = [];
  for (const [cid, info] of Object.entries(groups)) {
    const r = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': t },
      body: JSON.stringify({ robotCode: env.APP_KEY, openConversationId: cid, msgKey: 'sampleMarkdown', msgParam: JSON.stringify(msg) }),
    });
    out.push({ group: info.title || cid, status: r.status, body: (await r.text()).slice(0, 200) });
  }
  return out;
}

async function robotCallback(req, env) {
  const ts = req.headers.get('timestamp'), sign = req.headers.get('sign');
  // Unsigned requests (e.g. DingTalk checking the address is reachable) just get an empty OK; nothing is stored.
  if (!ts || !sign) return Response.json({ ok: true });
  if (Math.abs(Date.now() - Number(ts)) > 3600000) return new Response('bad', { status: 401 });
  const k = await crypto.subtle.importKey('raw', enc.encode(env.APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mine = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(ts + '\n' + env.APP_SECRET)))));
  if (mine !== sign) return new Response('bad sign', { status: 401 });
  const m = await req.json();
  if (m.conversationType === '2' && m.conversationId) {
    const groups = JSON.parse((await env.BOT.get('groups')) || '{}');
    groups[m.conversationId] = { title: m.conversationTitle || '', added: new Date().toISOString() };
    await env.BOT.put('groups', JSON.stringify(groups));
    return Response.json({ msgtype: 'text', text: { content: '✅ Taisho Reminder is set up for this group. Reminders will be posted here automatically.' } });
  }
  return Response.json({ msgtype: 'text', text: { content: 'Hi! Please add me to a group and @ me there.' } });
}

// Work notification from the DailyPlan app (shows up in each member's DingTalk chats). userids = null → everyone in the org.
let alertTokenCache = { v: null, exp: 0 };
async function alertToken(env) {
  if (alertTokenCache.v && alertTokenCache.exp > Date.now()) return alertTokenCache.v;
  const r = await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(env.ALERT_APP_KEY)}&appsecret=${encodeURIComponent(env.ALERT_APP_SECRET)}`);
  const j = await r.json();
  if (j.errcode !== 0) throw new Error('alert gettoken ' + j.errcode);
  alertTokenCache = { v: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return j.access_token;
}
// Reminders are sent by the separate "TaishoStaffAlerts" app so they show under that name.
async function sendWorkNotice(env, msg, userids) {
  const t = await alertToken(env);
  const body = { agent_id: Number(env.ALERT_AGENT_ID), msg: { msgtype: 'markdown', markdown: { title: msg.title, text: msg.text } } };
  if (userids && userids.length) body.userid_list = userids.join(','); else body.to_all_user = true;
  const r = await fetch(`https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${t}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return await r.json();
}

// ---------- Daily plan notice ----------
// One notice a day, at 00:10 Toronto, right after the page flips to the new day. Other updates send nothing.
const APP_URL = 'https://baldwin-plan.tbp8xufgw.workers.dev/';
// Opens the Baldwin Plan app inside DingTalk (logged in automatically).
const appLink = (env) => `dingtalk://dingtalkclient/action/openapp?corpid=${env.CORP_ID}&container_type=work_platform&app_id=0_${env.AGENT_ID}&redirect_type=jump&redirect_url=${encodeURIComponent(APP_URL)}`;

function dailyMsg(now, env) {
  const f = (o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', ...o }).format(now);
  const day = f({ weekday: 'long' }), date = f({ month: 'short', day: 'numeric' });
  return {
    title: `📋 ${day}’s Service Plan is ready — ${date} 🍽️`,
    text: [
      `### 📋 ${day}’s Service Plan is ready — ${date} 🍽️`,
      `📲 Tap [here](${appLink(env)}) to see where you’re working today and check the reservations 🗓️`,
      '✅ Tap **Done** as soon as you finish each checklist item.',
      '👀 If you’re supervising, please double-check the team’s completed tasks and sign off ✍️',
      'Thanks, team! Good night 🌙😴',
    ].join('\n\n'),
  };
}

function torontoDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function dailyNotice(env, now) {
  if (torontoHour(now) !== 0) return;                       // two UTC crons; only the one that is 00:10 in Toronto sends
  const today = torontoDate(now);
  if ((await env.BOT.get('daily_sent')) === today) return;  // never more than one a day
  await env.BOT.put('daily_sent', today);
  const r = await sendWorkNotice(env, dailyMsg(now, env), null);
  await env.BOT.put('daily_last_result', JSON.stringify({ at: new Date().toISOString(), r }));
}

function torontoHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(d));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const sec = { 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };

    if (url.pathname === '/auth' && req.method === 'POST') return auth(req, env);
    if (url.pathname === '/robot' && req.method === 'POST') return robotCallback(req, env);
    if (url.pathname === '/api/checkoff' && req.method === 'POST') return checkoff(req, env);
    if (url.pathname === '/robot/admin' && req.method === 'POST') {
      if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) return new Response('Forbidden', { status: 403 });
      const b = await req.json().catch(() => ({}));
      if (b.action === 'groups') return Response.json(JSON.parse((await env.BOT.get('groups')) || '{}'));
      if (b.action === 'send') return Response.json(await sendToGroups(env, REMINDER));
      if (b.action === 'result') {
        const t = await alertToken(env);
        const r = await fetch(`https://oapi.dingtalk.com/topapi/message/corpconversation/getsendresult?access_token=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: Number(env.ALERT_AGENT_ID), task_id: Number(b.task_id) }) });
        return Response.json(await r.json());
      }
      if (b.action === 'daily') return Response.json({ test: await env.BOT.get('test_last_result'), sent: await env.BOT.get('daily_sent'), last: await env.BOT.get('daily_last_result') });
      if (b.action === 'notice') return Response.json(await sendWorkNotice(env, b.msg || REMINDER, b.userids));
      return Response.json({ ok: false });
    }

    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
      const s = await readSession(req, env);
      if (!s) {
        if (url.pathname === '/app' || url.pathname === '/app/' || url.pathname.endsWith('.html')) return Response.redirect(url.origin + '/' + url.search, 302);
        return new Response('Forbidden', { status: 403, headers: sec });
      }
      // Self-test: opening the app with ?sendtest=1 sends today's plan notice to the person who opened it (only to them, max once a minute).
      if (url.searchParams.get('sendtest') === '1') {
        const k = 'test_' + s.u;
        if (!(await env.BOT.get(k))) {
          await env.BOT.put(k, '1', { expirationTtl: 60 });
          const r = await sendWorkNotice(env, dailyMsg(new Date(), env), [s.u]).catch((e) => ({ err: String(e) }));
          await env.BOT.put('test_last_result', JSON.stringify({ at: new Date().toISOString(), r }));
        }
        url.searchParams.delete('sendtest');
        return Response.redirect(url.toString(), 302);
      }
      const canViews = String(env.VIEWERS || '').split(',').map((x) => x.trim()).includes(String(s.u));
      if (url.pathname === '/app/views') return canViews ? viewsPage(env, url) : Response.redirect(url.origin + '/app/', 302);
      // Manager dashboard: only for managers; everyone else just gets the normal page.
      if (url.searchParams.get('view') === 'manager' && !s.m) {
        url.searchParams.delete('view');
        return Response.redirect(url.toString(), 302);
      }
      const res = await env.ASSETS.fetch(req);
      const h = new Headers(res.headers);
      Object.entries(sec).forEach(([k, v]) => h.set(k, v));
      h.set('cache-control', 'private, no-store');
      const out = new Response(res.body, { status: res.status, headers: h });
      if ((h.get('content-type') || '').includes('text/html')) {
        let rw = new HTMLRewriter().on('head', new Me(s)).on('body', new PrivacyNote()).on('body', new Watermark(s.n));
        if (s.m && url.searchParams.get('view') !== 'manager') rw = rw.on('body', new MgrButton());
        if (canViews && url.searchParams.get('view') !== 'manager') rw = rw.on('body', new ViewsButton());
        return rw.transform(out);
      }
      return out;
    }

    return new Response(BOOT(env.CORP_ID), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...sec } });
  },
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    if (event.cron === '10 4 * * *' || event.cron === '10 5 * * *') { ctx.waitUntil(dailyNotice(env, now)); return; }
    // Runs at 19:00 and 20:00 UTC on Wednesdays; only the run that is 15:00 in Toronto sends (handles daylight saving).
    if (torontoHour(now) === 15) ctx.waitUntil(sendWorkNotice(env, REMINDER, null));
  },
};
