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
    const body = b64(JSON.stringify({ u: j.result.userid, n: j.result.name || '', exp: Date.now() + SESSION_MIN * 60000 }));
    const cookie = `bp=${body}.${await hmac(env.SESSION_KEY, body)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MIN * 60}`;
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
    '🔄 Late requests may not be approved. If you miss the cutoff and get scheduled, please arrange a shift swap.',
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

function torontoHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(d));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const sec = { 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };

    if (url.pathname === '/auth' && req.method === 'POST') return auth(req, env);
    if (url.pathname === '/robot' && req.method === 'POST') return robotCallback(req, env);
    if (url.pathname === '/robot/admin' && req.method === 'POST') {
      if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) return new Response('Forbidden', { status: 403 });
      const b = await req.json().catch(() => ({}));
      if (b.action === 'groups') return Response.json(JSON.parse((await env.BOT.get('groups')) || '{}'));
      if (b.action === 'send') return Response.json(await sendToGroups(env, REMINDER));
      if (b.action === 'notice') return Response.json(await sendWorkNotice(env, b.msg || REMINDER, b.userids));
      return Response.json({ ok: false });
    }

    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
      const s = await readSession(req, env);
      if (!s) {
        if (url.pathname === '/app' || url.pathname === '/app/' || url.pathname.endsWith('.html')) return Response.redirect(url.origin + '/' + url.search, 302);
        return new Response('Forbidden', { status: 403, headers: sec });
      }
      const res = await env.ASSETS.fetch(req);
      const h = new Headers(res.headers);
      Object.entries(sec).forEach(([k, v]) => h.set(k, v));
      h.set('cache-control', 'private, no-store');
      const out = new Response(res.body, { status: res.status, headers: h });
      if ((h.get('content-type') || '').includes('text/html')) return new HTMLRewriter().on('body', new Watermark(s.n)).transform(out);
      return out;
    }

    return new Response(BOOT(env.CORP_ID), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...sec } });
  },
  async scheduled(event, env, ctx) {
    // Runs at 19:00 and 20:00 UTC on Wednesdays; only the run that is 15:00 in Toronto sends (handles daylight saving).
    if (torontoHour(new Date(event.scheduledTime)) === 15) ctx.waitUntil(sendWorkNotice(env, REMINDER, null));
  },
};
