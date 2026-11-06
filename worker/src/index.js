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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const sec = { 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };

    if (url.pathname === '/auth' && req.method === 'POST') return auth(req, env);

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
};
