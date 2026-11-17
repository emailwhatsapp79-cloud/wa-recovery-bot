// Server-rendered HTML pages. Plain HTML + a little vanilla JS, mobile-first.
//
// Design: "the message that came back". A cool paper background, navy ink, and chat
// bubbles as the one recurring visual idea. Read-receipt blue is the only accent.
// Type: Bricolage Grotesque (headlines) + Figtree (everything else).
const { APP_NAME } = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">';

const CSS = `
:root{
  --paper:#F2F4F8; --surface:#FFFFFF; --ink:#13203B; --ink2:#5A657C; --line:#DDE2EC;
  --tick:#1A86E0; --tick-soft:#E3F0FC; --mint:#D9F2E4; --mint-ink:#0F5C3A;
  --warn:#9A5B00; --warn-soft:#FFF1D6; --bad:#B42318; --bad-soft:#FDE7E5;
  --display:'Bricolage Grotesque',ui-sans-serif,system-ui,sans-serif; --body:'Figtree',ui-sans-serif,system-ui,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 var(--body);-webkit-font-smoothing:antialiased}
a{color:var(--tick);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--tick);outline-offset:2px;border-radius:6px}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header.top{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;max-width:1040px;margin:0 auto}
.brand{white-space:nowrap;display:flex;align-items:center;gap:10px;font:700 19px/1 var(--display);color:var(--ink);text-decoration:none;letter-spacing:-.2px}
.brand svg{flex:none}
nav{display:flex;gap:4px;align-items:center;white-space:nowrap}
nav a{color:var(--ink2);text-decoration:none;font-weight:600;font-size:15px;padding:8px 12px;border-radius:999px}
nav a:hover{color:var(--ink);background:#E7EBF2}
nav a.cta{background:var(--ink);color:#fff}nav a.cta:hover{background:#22325A;color:#fff}

h1,h2,h3{font-family:var(--display);letter-spacing:-.02em;margin:0}
.btn,button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:600 16px/1 var(--body);
  padding:14px 20px;border-radius:999px;border:0;cursor:pointer;text-decoration:none;background:var(--ink);color:#fff;transition:background .15s}
.btn:hover,button:hover{background:#22325A}
.btn.light,button.light{background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--line)}
.btn.light:hover,button.light:hover{background:#F7F9FC}
button.danger{background:var(--bad-soft);color:var(--bad)}button.danger:hover{background:#FBD5D1}
button:disabled{opacity:.55;cursor:default}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.muted{color:var(--ink2)}
.err{color:var(--bad);min-height:22px;font-size:15px;margin-top:10px}.good{color:var(--mint-ink)}

/* ---------- chat bubbles: the recurring idea ---------- */
.bubble{position:relative;max-width:86%;padding:9px 12px 20px;border-radius:14px;font-size:15.5px;line-height:1.4;background:var(--surface);box-shadow:0 1px 0 rgba(19,32,59,.08)}
.bubble.in{border-top-left-radius:4px;align-self:flex-start}
.bubble.out{border-top-right-radius:4px;align-self:flex-end;background:var(--mint)}
.bubble .meta{position:absolute;right:10px;bottom:4px;font-size:11.5px;color:var(--ink2)}
.bubble .who{display:block;font-weight:700;font-size:13px;color:var(--tick);margin-bottom:2px}
.bubble.deleted{color:var(--ink2);font-style:italic}
.ticks{color:var(--tick);letter-spacing:-3px;margin-left:4px}

/* ---------- landing ---------- */
.wrap.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center;padding-top:40px;padding-bottom:72px}
.hero h1{font-size:clamp(44px,7vw,78px);line-height:.98;font-weight:800;max-width:11ch}
.hero p.lede{font-size:20px;color:var(--ink2);max-width:34ch;margin:22px 0 30px}
.phone{background:#E9EDF4;border-radius:28px;padding:16px;box-shadow:0 30px 60px -30px rgba(19,32,59,.35),inset 0 0 0 1.5px #D6DCE7}
.chathead{display:flex;align-items:center;gap:10px;padding:4px 6px 12px;font-weight:700;font-size:15px}
.avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font:700 14px var(--display);color:#fff;background:#6C5CE7}
.avatar.me{background:var(--ink)}
.chat{display:flex;flex-direction:column;gap:8px;min-height:150px}
.divider{margin:16px 0 12px;display:flex;align-items:center;gap:10px;color:var(--ink2);font-size:13px;font-weight:600}
.divider:before,.divider:after{content:"";flex:1;height:1.5px;background:#D6DCE7}

/* the one orchestrated moment: a message is deleted, then comes back to you */
.swap{display:grid}.swap>*{grid-area:1/1}
.swap .orig{animation:fadeOut .5s ease 1.6s forwards}
.swap .gone{opacity:0;animation:fadeIn .5s ease 1.9s forwards}
.back{opacity:0;transform:translateY(10px);animation:rise .6s cubic-bezier(.2,.8,.2,1) 2.9s forwards}
@keyframes fadeOut{to{opacity:0}}@keyframes fadeIn{to{opacity:1}}@keyframes rise{to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.swap .orig{animation:none;opacity:0}.swap .gone,.back{animation:none;opacity:1;transform:none}}

section.block{padding:64px 0;border-top:1.5px solid var(--line)}
section.block h2{font-size:clamp(30px,4vw,42px);max-width:18ch}
section.block>.wrap>p.muted{max-width:56ch;font-size:18px;margin:12px 0 0}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:36px;margin-top:40px;padding:0;list-style:none;counter-reset:s}
.steps li{counter-increment:s}
.steps li:before{content:counter(s);display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--ink);color:#fff;font:700 18px var(--display);margin-bottom:14px}
.steps h3{font-size:21px;margin-bottom:6px}.steps p{margin:0;color:var(--ink2)}
.recovers{display:grid;grid-template-columns:repeat(2,1fr);gap:14px 40px;margin-top:36px}
.recovers div{display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-bottom:1.5px solid var(--line)}
.recovers b{display:block;font-size:17px}.recovers span{color:var(--ink2);font-size:15.5px}
.ico{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--tick-soft);font-size:19px}
.cmds{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start;margin-top:36px}
.cmd{background:#E9EDF4;border-radius:20px;padding:16px;display:flex;flex-direction:column;gap:8px}
.cmd h3{font-size:22px;margin:8px 4px 2px}.cmd p{margin:0 4px 4px;color:var(--ink2)}
.quote{border-left:3px solid var(--tick);padding:2px 0 2px 8px;margin-bottom:6px;font-size:13.5px;color:var(--ink2)}
.invite-band{background:var(--ink);color:#fff;border-radius:28px;padding:44px;display:flex;justify-content:space-between;gap:30px;align-items:center;flex-wrap:wrap}
.invite-band h2{color:#fff;font-size:34px}.invite-band p{color:#B9C3D6;margin:10px 0 0;max-width:46ch}
.invite-band .btn{background:#fff;color:var(--ink)}.invite-band .btn:hover{background:#E9EDF4}
.band-btns{display:flex;gap:10px;flex-wrap:wrap}.invite-band .btn.ghost{background:transparent;color:#fff;box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.45)}.invite-band .btn.ghost:hover{background:rgba(255,255,255,.08)}
.done-box{text-align:center;padding:8px 0}.done-box .tick{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px;background:var(--mint-soft,#DDF5EA);color:var(--mint-ink,#0B6B47);font-size:28px}
footer{padding:36px 0 56px;color:var(--ink2);font-size:14px}footer p{max-width:70ch}

/* ---------- auth ---------- */
.auth{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center;padding:32px 0 64px}
.auth h1{font-size:clamp(36px,5vw,52px);line-height:1.02;font-weight:800}
.auth .side p{color:var(--ink2);font-size:18px;max-width:34ch}
.panel{background:var(--surface);border-radius:24px;padding:28px;box-shadow:0 1px 0 rgba(19,32,59,.06),0 20px 40px -28px rgba(19,32,59,.3)}
label{display:block;font-weight:600;font-size:15px;margin:16px 0 6px}
label small{font-weight:500;color:var(--ink2)}
input{width:100%;padding:13px 14px;border-radius:12px;border:1.5px solid var(--line);background:#FBFCFE;color:var(--ink);font:16px var(--body)}
input:focus{outline:none;border-color:var(--tick);box-shadow:0 0 0 3px var(--tick-soft)}
input.code{font:600 20px/1 var(--display);letter-spacing:2px;text-transform:uppercase}
.hint{font-size:14px;color:var(--ink2);margin-top:6px}
.panel button{width:100%;margin-top:22px}

/* ---------- app (dashboard/admin) ---------- */
.app{padding:12px 0 72px}
.app h1{font-size:38px;font-weight:800;margin:10px 0 20px}
.status{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:20px 22px;border-radius:22px;background:var(--surface);box-shadow:0 1px 0 rgba(19,32,59,.06)}
.dot{width:12px;height:12px;border-radius:50%;flex:none}
.state-ok .dot{background:#16A34A;box-shadow:0 0 0 5px #DCFCE7}.state-wait .dot{background:#D97706;box-shadow:0 0 0 5px #FEF3C7}.state-off .dot{background:#9CA3AF;box-shadow:0 0 0 5px #EEF0F3}
.status .label{font:700 20px var(--display)}.status .sub{color:var(--ink2);font-size:15px}
#linkArea{width:100%}
.code-tap{display:block;width:100%;border:0;cursor:pointer;box-shadow:inset 0 0 0 2px var(--tick)}.code-tap:hover{background:var(--tick-soft)}
.code-big{font:800 clamp(26px,8vw,38px)/1 var(--display);letter-spacing:2px;white-space:nowrap;padding:18px;border-radius:16px;background:var(--tick-soft);color:var(--ink);text-align:center;margin:10px 0}
img.qr{background:#fff;padding:10px;border-radius:16px;max-width:240px;width:100%;box-shadow:inset 0 0 0 1.5px var(--line)}
.sec{margin-top:40px}.sec h2{font-size:24px;margin-bottom:4px}.sec>p.muted{margin:0 0 14px;max-width:60ch}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:0;background:var(--surface);border-radius:20px;overflow:hidden}
.stats div{padding:18px 20px;border-right:1.5px solid var(--paper)}.stats div:last-child{border:0}
.stats b{display:block;font:800 34px/1.1 var(--display)}.stats span{color:var(--ink2);font-size:14.5px}
.list{background:var(--surface);border-radius:20px;padding:4px 20px}
.toggle{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 0;border-bottom:1.5px solid var(--paper)}
.toggle:last-child{border:0}.toggle small{display:block;color:var(--ink2);font-size:14px}
.sw{position:relative;flex:none;width:50px;height:30px}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:1}
.sw span{position:absolute;inset:0;border-radius:99px;background:#CDD4E0;transition:background .15s}
.sw span:after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s}
.sw input:checked+span{background:var(--tick)}.sw input:checked+span:after{transform:translateX(20px)}
.sw input:focus-visible+span{outline:3px solid var(--tick);outline-offset:2px}
.cmdlist{display:grid;grid-template-columns:auto 1fr;gap:10px 16px;background:var(--surface);border-radius:20px;padding:20px}
.cmdlist code{font:700 15px var(--display);background:var(--tick-soft);color:var(--ink);padding:4px 10px;border-radius:8px;justify-self:start}
.timeline{background:var(--surface);border-radius:20px;padding:6px 20px;max-height:420px;overflow:auto}
.timeline div{display:grid;grid-template-columns:12px 1fr;gap:12px;padding:12px 0;border-bottom:1.5px solid var(--paper);font-size:15px}
.timeline div:last-child{border:0}
.timeline i{width:10px;height:10px;border-radius:50%;margin-top:7px;background:#9CA3AF}
.timeline .info i{background:var(--tick)}.timeline .warn i{background:#D97706}.timeline .error i{background:var(--bad)}
.timeline .error{color:var(--bad)}.timeline time{display:block;font-size:13px;color:var(--ink2)}
.acct{background:var(--surface);border-radius:20px;padding:20px;max-width:480px}
table{width:100%;border-collapse:collapse;background:var(--surface);border-radius:20px;overflow:hidden;font-size:15px}
th{font-weight:600;color:var(--ink2);font-size:14px;text-align:left;padding:12px 14px;background:#F7F9FC}
td{padding:12px 14px;border-top:1.5px solid var(--paper);vertical-align:top}td b{white-space:nowrap}
.tag{display:inline-block;padding:3px 10px;border-radius:99px;font-size:13px;font-weight:600}
.tag.ok{background:var(--mint);color:var(--mint-ink)}.tag.used{background:var(--tick-soft);color:#11528A}.tag.rev{background:var(--bad-soft);color:var(--bad)}
.tag.wait{background:var(--warn-soft);color:var(--warn)}.tag.off{background:#EEF0F3;color:var(--ink2)}
.small{font-size:14px}.tablewrap{overflow-x:auto;border-radius:20px}
td .row button{padding:9px 14px;font-size:14px}

@media (max-width:820px){
  .wrap.hero,.auth,.cmds{grid-template-columns:1fr;gap:32px}.wrap.hero{padding-top:16px;padding-bottom:56px}
  .steps,.recovers{grid-template-columns:1fr;gap:24px}
  .stats{grid-template-columns:repeat(2,1fr)}.stats div:nth-child(2){border-right:0}.stats div:nth-child(-n+2){border-bottom:1.5px solid var(--paper)}
  .invite-band{padding:30px}
}
@media (max-width:560px){
  header.top{padding:14px 16px}nav a{padding:8px 9px;font-size:14px}.brand{font-size:17px;gap:8px}
  .wrap{padding:0 16px}
  table,tbody,tr,td{display:block;width:100%}table{background:none}th,tr:has(th){display:none}
  tr{background:var(--surface);border-radius:16px;padding:6px 4px;margin-bottom:10px}
  td{border:0;padding:6px 14px}td:empty{display:none}
}
`;

const PW_CSS = `
.pw{position:relative}.pw input{padding-right:56px}
.pw .eye,.panel .pw .eye{margin:0;position:absolute;right:4px;top:50%;transform:translateY(-50%);width:46px!important;height:46px;padding:0;border-radius:12px;background:none;color:var(--ink2);box-shadow:none}
.pw .eye:hover{background:#EEF1F6;color:var(--ink)}.pw .eye svg{width:22px;height:22px}
.caps{display:none;font-size:13px;color:var(--bad);margin-top:6px}.caps.on{display:block}
`;
const PW_JS = `
function pwEyes(){var E='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
H='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.5 9.5 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
document.querySelectorAll('input[type=password]').forEach(function(i){if(i.parentNode.classList.contains('pw'))return;
i.setAttribute('autocapitalize','off');i.setAttribute('spellcheck','false');
var w=document.createElement('div');w.className='pw';i.parentNode.insertBefore(w,i);w.appendChild(i);
var b=document.createElement('button');b.type='button';b.className='eye';b.setAttribute('aria-label','Show password');b.innerHTML=E;w.appendChild(b);
var c=document.createElement('div');c.className='caps';c.textContent='Caps Lock is on';w.after(c);
b.onclick=function(){var show=i.type==='password';i.type=show?'text':'password';b.innerHTML=show?H:E;b.setAttribute('aria-label',show?'Hide password':'Show password');i.focus()};
i.addEventListener('keyup',function(e){if(e.getModifierState)c.classList.toggle('on',e.getModifierState('CapsLock'))});
i.addEventListener('blur',function(){c.classList.remove('on')});});}
pwEyes();
`;

const LOGO = `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M6 4h20a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H13l-7 5v-5H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="#13203B"/><path d="M11 15.5l3 3 7-7" stroke="#5FB6FF" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function layout(title, body, user, script = '', { wide = false } = {}) {
  const nav = user
    ? `<nav><a href="/dashboard">Dashboard</a>${user.isAdmin ? '<a href="/admin">Admin</a>' : ''}<a href="#" onclick="logout();return false">Log out</a></nav>`
    : `<nav><a href="/login">Log in</a><a class="cta" href="/signup">Sign up</a></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(APP_NAME)}</title>${FONTS}<style>${CSS}${PW_CSS}</style></head><body>
<header class="top"><a class="brand" href="/">${LOGO}${esc(APP_NAME)}</a>${nav}</header>
${wide ? body : `<main class="wrap">${body}</main>`}
<script>
async function api(url, body){const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
let j={};try{j=await r.json()}catch{}if(r.status===401&&!location.pathname.startsWith('/login'))location='/login';if(!r.ok)throw new Error(j.error||('Error '+r.status));return j}
async function logout(){if(!confirm('Log out of your account? Your bot keeps running.'))return;await api('/api/logout',{});location='/login'}
const $=(id)=>document.getElementById(id);const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
${script}
${PW_JS}
</script></body></html>`;
}

function landing(user) {
  return layout('Deleted doesn\'t mean gone', `
<main>
<div class="wrap hero">
  <div>
    <h1>Deleted doesn't mean gone.</h1>
    <p class="lede">Link your WhatsApp once. When someone deletes or edits a message, the original comes straight to your own chat.</p>
    <div class="row">${user ? '<a class="btn" href="/dashboard">Open your dashboard</a>'
      : '<a class="btn" href="/signup">Sign up with an invite</a><a class="btn light" href="/login">Log in</a>'}</div>
  </div>
  <div class="phone" aria-label="Example: a deleted message is recovered">
    <div class="chathead"><div class="avatar">T</div>Tolu</div>
    <div class="chat">
      <div class="bubble in">Abeg are you coming to the 2pm lecture?<span class="meta">13:58</span></div>
      <div class="swap">
        <div class="bubble in orig">Don't tell anyone but the test is next Monday<span class="meta">13:59</span></div>
        <div class="bubble in deleted gone">🚫 This message was deleted<span class="meta">13:59</span></div>
      </div>
    </div>
    <div class="divider">Your "Message yourself" chat</div>
    <div class="chat" style="min-height:0">
      <div class="bubble out back"><span class="who">🗑️ Deleted message · Tolu</span>Don't tell anyone but the test is next Monday<span class="meta">13:59<span class="ticks">✓✓</span></span></div>
    </div>
  </div>
</div>

<section class="block"><div class="wrap">
  <h2>Set up in two minutes</h2>
  <ol class="steps">
    <li><h3>Get an invite</h3><p>Accounts are invite-only. Ask whoever runs this for a code.</p></li>
    <li><h3>Link your WhatsApp</h3><p>Enter the 8-digit code in WhatsApp → Linked devices. Same as WhatsApp Web.</p></li>
    <li><h3>Carry on as normal</h3><p>Anything deleted or edited shows up in your "Message yourself" chat.</p></li>
  </ol>
</div></section>

<section class="block"><div class="wrap">
  <h2>What comes back</h2>
  <div class="recovers">
    <div><span class="ico">💬</span><p style="margin:0"><b>Deleted texts</b><span>The full message, who sent it, and which chat.</span></p></div>
    <div><span class="ico">✏️</span><p style="margin:0"><b>Edited messages</b><span>What it said before, next to what it says now.</span></p></div>
    <div><span class="ico">🖼️</span><p style="margin:0"><b>Photos and videos</b><span>Saved as they arrive, so a delete can't take them.</span></p></div>
    <div><span class="ico">🎙️</span><p style="margin:0"><b>Voice notes, stickers, files</b><span>Recovered the same way, in groups too.</span></p></div>
  </div>
</div></section>

<section class="block"><div class="wrap">
  <h2>View-once, kept</h2>
  <p class="muted">Reply to a view-once photo, video or voice note with a short command. Your command deletes itself.</p>
  <div class="cmds">
    <div class="cmd">
      <div class="bubble in" style="max-width:70%">📷 Photo · View once<span class="meta">20:14</span></div>
      <div class="bubble out"><div class="quote">📷 Photo · View once</div>.vv<span class="meta">20:14<span class="ticks">✓✓</span></span></div>
      <h3>.vv sends it to you</h3><p>The photo lands privately in your "Message yourself" chat.</p>
    </div>
    <div class="cmd">
      <div class="bubble in" style="max-width:70%"><span class="who">Class rep</span>🎥 Video · View once<span class="meta">20:15</span></div>
      <div class="bubble out"><div class="quote">🎥 Video · View once</div>.vvc<span class="meta">20:15<span class="ticks">✓✓</span></span></div>
      <h3>.vvc posts it in the chat</h3><p>Everyone in that chat or group can see it again.</p>
    </div>
  </div>
</div></section>

<section class="block"><div class="wrap">
  <div class="invite-band">
    <div><h2>Invite only, for now</h2><p>Each account is set up by invitation, so the service stays fast and private for the people using it.</p></div>
    ${user ? '<a class="btn" href="/dashboard">Open your dashboard</a>' : '<div class="band-btns"><a class="btn" href="/signup">I have an invite code</a><a class="btn ghost" href="/request">Request a code</a></div>'}
  </div>
</div></section>

<footer class="wrap"><p>${esc(APP_NAME)} is an unofficial tool that connects to your own WhatsApp as a linked device. Use it on your own account and respect other people's privacy. WhatsApp can restrict accounts that use unofficial tools.</p></footer>
</main>`, user, '', { wide: true });
}

function authForm(kind) {
  const signup = kind === 'signup';
  const side = signup
    ? `<h1>Create your account</h1><p>You'll need the invite code you were sent. After this you'll link your WhatsApp from the dashboard.</p>`
    : `<h1>Welcome back</h1><p>Log in to see your connection, your settings and everything the bot recovered.</p>`;
  return layout(signup ? 'Sign up' : 'Log in', `
<div class="auth">
  <div class="side">${side}</div>
  <form class="panel" id="f" novalidate>
    ${signup ? `<label for="invite">Invite code</label><input id="invite" class="code" autocomplete="off" autocapitalize="characters" placeholder="ABCDE-FGHJK" required>
    <div class="hint">No code? <a href="/request">Request one here</a> and it'll be sent to your WhatsApp.</div>` : ''}
    <label for="email">Email</label><input id="email" type="email" autocomplete="email" inputmode="email" required>
    <label for="password">Password ${signup ? '<small>· at least 8 characters</small>' : ''}</label>
    <input id="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
    ${signup ? '<label for="password2">Repeat password</label><input id="password2" type="password" autocomplete="new-password" required>' : ''}
    ${signup ? '' : '<div class="hint" style="margin-top:8px">Forgot your password? Ask the admin to set a new one for you.</div>'}
    <button id="go" type="submit">${signup ? 'Create account' : 'Log in'}</button>
    <div class="err" id="err" role="alert"></div>
    <p class="muted small" style="margin:6px 0 0">${signup ? 'Already have an account? <a href="/login">Log in</a>' : 'Have an invite code? <a href="/signup">Sign up</a>'}</p>
  </form>
</div>`, null, `
const q=new URLSearchParams(location.search);if(q.get('invite')&&$('invite'))$('invite').value=q.get('invite');
const goTxt=$('go').textContent;$('f').onsubmit=async(e)=>{e.preventDefault();$('err').textContent='';$('go').disabled=true;$('go').textContent='Please wait…';
try{${signup
    ? "if(!$('invite').value.trim())throw new Error('Enter your invite code.');if(!$('email').value.includes('@'))throw new Error('Enter a valid email.');if($('password').value.length<8)throw new Error('Password must be at least 8 characters.');if($('password').value!==$('password2').value)throw new Error('The two passwords don\\'t match.');await api('/api/signup',{invite:$('invite').value,email:$('email').value,password:$('password').value});"
    : "await api('/api/login',{email:$('email').value,password:$('password').value});"}
location='/dashboard'}catch(err){$('err').textContent=err.message;$('go').disabled=false;$('go').textContent=goTxt}};`);
}

function requestInvite() {
  return layout('Request an invite', `
<div class="auth">
  <div class="side"><h1>Get an invite code</h1><p>Leave your WhatsApp number. When your request is approved, your code arrives on WhatsApp with a link to sign up.</p></div>
  <div class="panel" id="box">
  <form id="f" novalidate>
    <label for="name" style="margin-top:0">Your name <small>· so we know who's asking</small></label>
    <input id="name" autocomplete="name" maxlength="60" placeholder="Tolu">
    <label for="phone">WhatsApp number</label>
    <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="2348012345678" required>
    <div class="hint">Include your country code. 080… numbers are treated as Nigerian.</div>
    <button id="go" type="submit">Send me a code</button>
    <div class="err" id="err" role="alert"></div>
    <p class="muted small" style="margin:6px 0 0">Already have a code? <a href="/signup">Sign up</a> · <a href="/login">Log in</a></p>
  </form>
  </div>
</div>`, null, `
$('f').onsubmit=async(e)=>{e.preventDefault();$('err').textContent='';const b=$('go');b.disabled=true;b.textContent='Sending…';
try{const r=await api('/api/request-invite',{name:$('name').value,phone:$('phone').value});
$('box').innerHTML='<div class="done-box"><div class="tick">✓</div><h2 style="font-size:26px;margin-bottom:8px">'+(r.status==='sent'?'Code sent':'Request sent')+'</h2><p class="muted" style="margin:0 auto;max-width:32ch">'+(r.status==='sent'?'Check WhatsApp on <b>+'+esc(r.phone)+'</b>. Your code and sign-up link are there.':'When it\\'s approved, your code will arrive on WhatsApp at <b>+'+esc(r.phone)+'</b>.')+'</p><a class="btn" style="margin-top:20px" href="/signup">I have my code</a></div>';
}catch(err){$('err').textContent=err.message;b.disabled=false;b.textContent='Send me a code'}};`);
}

// ---------- logged-in app (dashboard + admin) ----------
// Mobile-first app shell: a top bar, one screen at a time, and a tab bar at the bottom
// (on wide screens the tabs sit under the top bar). Client code is written as real
// functions and injected with .toString(), so there is no string escaping to get wrong.

const APP_CSS = `
.shell{max-width:760px;margin:0 auto;padding:0 18px 140px}
#s-invites{padding-bottom:90px}
.apptop{position:sticky;top:0;z-index:20;background:rgba(242,244,248,.92);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px)}
.apptop .in{max-width:760px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:12px 16px}
.me-chip{display:flex;align-items:center;gap:8px;font:600 14px var(--body);color:var(--ink2);max-width:60%;min-width:0;background:none;box-shadow:none;padding:4px 4px 4px 12px;border-radius:999px;min-height:44px}.me-chip:hover{background:#E7EBF2;color:var(--ink)}.me-chip .chev{width:16px;height:16px;flex:none}
.menu-who{display:flex;align-items:center;gap:12px;padding:4px 0 14px;border-bottom:1.5px solid var(--line);margin-bottom:6px}.menu-who .initial{width:44px;height:44px;font-size:18px}.menu-who b{display:block;font-size:16px;word-break:break-all}.menu-who small{color:var(--ink2);font-size:13px}
.menu-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}.menu-list a,.menu-list button{display:flex;align-items:center;justify-content:flex-start;gap:14px;width:100%;min-height:54px;padding:12px 14px;border-radius:14px;background:none;box-shadow:none;color:var(--ink);font:600 16px var(--body);text-decoration:none}.menu-list a:hover,.menu-list button:hover{background:#F1F4F8}.menu-list svg{width:22px;height:22px;flex:none;color:var(--ink2)}.menu-list .out{color:var(--bad)}.menu-list .out svg{color:var(--bad)}.menu-list .here{background:#F1F4F8}
.me-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apptop .in{gap:16px}@media (max-width:480px){.me-chip span{display:none}}
.initial{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--ink);color:#fff;font:700 14px var(--display);text-transform:uppercase}
.screen{display:none}.screen.on{display:block;animation:in .18s ease}
@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.screen.on{animation:none}}
.screen h1{font-size:30px;font-weight:800;margin:14px 0 4px}
.screen .lead{color:var(--ink2);margin:0 0 18px;font-size:15.5px}
.group{margin-top:30px}
.group>h2{font-size:13px;font-family:var(--body);font-weight:700;color:var(--ink2);letter-spacing:.02em;margin:0 4px 8px}
.card{background:var(--surface);border-radius:20px;padding:18px;box-shadow:0 1px 0 rgba(19,32,59,.05)}
.card+.card{margin-top:10px}

/* bottom tab bar */
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:30;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border-top:1px solid var(--line);padding:6px 8px calc(6px + env(safe-area-inset-bottom))}
.tabbar .in{max-width:560px;margin:0 auto;display:flex;justify-content:space-around}
.tab{appearance:none;background:none;border:0;color:var(--ink2);display:flex;flex-direction:column;align-items:center;gap:3px;
  font:600 11.5px/1 var(--body);padding:8px 4px;min-width:60px;min-height:52px;border-radius:14px;cursor:pointer;text-decoration:none}
.tab:hover{background:#F2F4F8;color:var(--ink)}
.tab svg{width:24px;height:24px}
.tab.on{color:var(--tick)}.tab.on svg{stroke-width:2.3}
@media (min-width:821px){
  .tabbar{position:sticky;top:57px;bottom:auto;border:0;background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;padding:0 16px}
  .tabbar .in{max-width:760px;justify-content:flex-start;gap:6px;border-bottom:1.5px solid var(--line);padding-bottom:8px}
  .tab{flex-direction:row;font-size:15px;gap:8px;min-height:40px;padding:8px 14px}.tab svg{width:20px;height:20px}
  .tab.on{background:var(--tick-soft)}
  .shell{padding-bottom:64px}
}

/* status hero */
.hero-status{display:flex;align-items:center;gap:14px}
.hero-status .big{font:700 22px/1.15 var(--display)}
.hero-status .sub{color:var(--ink2);font-size:15px;margin-top:2px}
.pulse{flex:none;width:46px;height:46px;border-radius:50%;display:grid;place-items:center}
.pulse i{width:14px;height:14px;border-radius:50%}
.st-ok .pulse{background:#DCFCE7}.st-ok .pulse i{background:#16A34A}
.st-wait .pulse{background:#FEF3C7}.st-wait .pulse i{background:#D97706}
.st-off .pulse{background:#EEF0F3}.st-off .pulse i{background:#9CA3AF}
.st-ok .pulse i{animation:beat 2s ease-in-out infinite}
@keyframes beat{50%{transform:scale(1.35);opacity:.7}}
@media (prefers-reduced-motion:reduce){.st-ok .pulse i{animation:none}}

/* tappable action tiles */
.actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:18px}
@media (max-width:360px){.actions{grid-template-columns:1fr 1fr}.actions .tile:last-child{grid-column:1/-1}}
.tile{appearance:none;border:0;cursor:pointer;background:#F4F6FA;color:var(--ink);border-radius:16px;padding:14px 8px;min-height:84px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;font:600 13.5px/1.2 var(--body);text-align:center}
.tile:hover{background:#E9EDF4}.tile svg{width:24px;height:24px}
.tile.danger{background:var(--bad-soft);color:var(--bad)}.tile.danger:hover{background:#FBD5D1}
.tile:disabled{opacity:.5}

.stat-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.stat{background:var(--surface);border-radius:18px;padding:16px 18px}
.stat b{display:block;font:800 30px/1.1 var(--display)}
.stat span{color:var(--ink2);font-size:14px}
@media (min-width:821px){.stat-grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}}

/* settings rows */
.rows{background:var(--surface);border-radius:20px;padding:2px 18px}
.rowi{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1.5px solid var(--paper);min-height:58px}
.rowi:last-child{border:0}
.rowi .t{font-weight:600;font-size:16px}.rowi small{display:block;color:var(--ink2);font-size:13.5px;line-height:1.35;margin-top:2px}
.rowi.dim{opacity:.45}

.cmd-row{display:flex;gap:14px;align-items:flex-start;padding:12px 0;border-bottom:1.5px solid var(--paper)}
.cmd-row:last-child{border:0}
.cmd-row code{flex:none;min-width:58px;text-align:center;font:700 15px var(--display);background:var(--tick-soft);color:#0F4C81;padding:6px 10px;border-radius:10px}

/* chips + list cards */
.chips{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 10px;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}
.chip{appearance:none;border:0;cursor:pointer;flex:none;padding:9px 14px;border-radius:99px;background:var(--surface);color:var(--ink2);font:600 14px var(--body);box-shadow:inset 0 0 0 1.5px var(--line)}
.chip.on{background:var(--ink);color:#fff;box-shadow:none}
.chip b{margin-left:4px;opacity:.7}
.search{position:relative;margin-bottom:10px}.search input{padding-left:42px;background:var(--surface)}
.search svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:18px;height:18px;color:var(--ink2)}
.item{background:var(--surface);border-radius:20px;padding:18px;margin-bottom:12px}
.item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.item-head .name{font-weight:700;font-size:16px;overflow-wrap:anywhere}
.item-head .tag{flex:none;margin-top:1px}
.manage{width:100%;margin-top:14px;min-height:46px;border-radius:14px;font-size:15px}
.sheet .opts{display:flex;flex-direction:column;gap:10px;margin-top:16px}.sheet .opts button{width:100%;min-height:52px;justify-content:flex-start;padding:14px 18px;border-radius:16px}
.sheet .opts small{display:block;font-weight:500;color:var(--ink2);font-size:13px;margin-top:3px}
.sheet .opts .lbl{text-align:left}
.inv-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.inv-actions .btn,.inv-actions button{min-height:46px;border-radius:14px;font-size:14.5px;padding:12px}
.linkbtn{appearance:none;background:none;border:0;color:var(--bad);font:600 14.5px var(--body);padding:12px 0 0;cursor:pointer;width:100%;text-align:center}
.linkbtn:hover{background:none;text-decoration:underline}
.item-head .when{color:var(--ink2);font-size:13.5px;margin-top:2px}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:14px 0 0;padding:12px 0 0;border-top:1.5px solid var(--paper)}
.facts div{min-width:0}.facts span{display:block;color:var(--ink2);font-size:12.5px}
.facts b{display:block;font-size:14.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btnrow{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px;margin-top:14px}
.btnrow button,.btnrow a.btn{padding:12px 8px;font-size:14px;min-height:46px;border-radius:14px;width:100%}
.btn.soft,button.soft{background:#F4F6FA;color:var(--ink)}.btn.soft:hover,button.soft:hover{background:#E9EDF4}
.codeline{display:flex;align-items:center;gap:10px}
.codeline .code{font:800 22px/1 var(--display);letter-spacing:2px}
.empty{text-align:center;padding:28px 16px;color:var(--ink2)}
.empty b{display:block;color:var(--ink);font-size:17px;margin-bottom:4px}

/* activity */
.feed{background:var(--surface);border-radius:20px;padding:4px 18px}
.ev{display:grid;grid-template-columns:28px 1fr;gap:10px;padding:13px 0;border-bottom:1.5px solid var(--paper);font-size:15px;line-height:1.4}
.ev:last-child{border:0}
.ev .ic{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-size:13px;background:var(--tick-soft);color:var(--tick)}
.ev.warn .ic{background:var(--warn-soft);color:var(--warn)}.ev.error .ic{background:var(--bad-soft);color:var(--bad)}
.ev.error .msg{color:var(--bad)}.ev time{display:block;font-size:12.5px;color:var(--ink2);margin-top:2px}

/* sheet (bottom drawer used for invites, link code, confirmations) */
.sheet-bg{position:fixed;inset:0;z-index:50;background:rgba(19,32,59,.4);display:none;align-items:flex-end;justify-content:center}
.sheet-bg.on{display:flex}
.sheet{background:var(--surface);width:100%;max-width:520px;border-radius:24px 24px 0 0;padding:10px 20px calc(24px + env(safe-area-inset-bottom));max-height:88vh;overflow:auto;animation:up .2s ease}
.sheet .grab{width:42px;height:5px;border-radius:9px;background:var(--line);margin:4px auto 14px}
.sheet h3{font-size:22px;margin-bottom:6px}
@keyframes up{from{transform:translateY(30px);opacity:.6}to{transform:none;opacity:1}}
@media (min-width:821px){.sheet-bg{align-items:center}.sheet{border-radius:24px}}
.toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(20px);opacity:0;z-index:60;background:var(--ink);color:#fff;
  padding:12px 18px;border-radius:14px;font-weight:600;font-size:14.5px;transition:all .2s;pointer-events:none;max-width:90vw;text-align:center}
.toast.on{opacity:1;transform:translateX(-50%)}
.fab{position:fixed;right:18px;bottom:92px;z-index:25;box-shadow:0 10px 24px -8px rgba(19,32,59,.5);padding:15px 20px}
@media (min-width:821px){.fab{bottom:28px;right:max(18px,calc(50% - 360px))}.toast{bottom:32px}}
.wide-btn{width:100%;margin-top:14px;min-height:52px}
.btn svg,button svg{width:20px;height:20px;flex:none}.tile svg{width:24px;height:24px}.tab svg{width:24px;height:24px}@media (min-width:821px){.tab svg{width:20px;height:20px}}
`;

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.6-5.5 6.5-5.5s5.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .8 3.2 2.6 3.7 5.2"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 0 4v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4a2 2 0 0 1 0-4V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" transform="translate(0 1.5)"/><path d="M14 6v12" stroke-dasharray="2 2.5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8-1.5-1.5a4 4 0 0 0-5-5L14 5z" transform="scale(.9) translate(1.3 1.3)"/><path d="M5 19l3-3"/>',
  unlink: '<path d="M9 15l6-6M10.5 6.5l1.3-1.3a4 4 0 0 1 5.7 5.7l-1.3 1.3M13.5 17.5l-1.3 1.3a4 4 0 0 1-5.7-5.7l1.3-1.3M4 4l2 2M18 18l2 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  share: '<path d="M12 15V3M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

/** Shared app chrome: top bar, tab bar, sheet, toast, and small client helpers. */
function appLayout(title, user, tabs, screens, client, initial) {
  const tabBtns = tabs.map((t) => t.href
    ? `<a class="tab" href="${t.href}">${icon(t.icon)}<span>${t.label}</span></a>`
    : `<button class="tab" data-tab="${t.id}" aria-label="${t.label}">${icon(t.icon)}<span>${t.label}</span></button>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#F2F4F8"><title>${esc(title)} · ${esc(APP_NAME)}</title>${FONTS}<style>${CSS}${APP_CSS}${PW_CSS}</style></head><body>
<div class="apptop"><div class="in"><a class="brand" href="/">${LOGO}${esc(APP_NAME)}</a>
<button class="me-chip" id="meBtn" aria-haspopup="dialog" aria-label="Account menu"><span>${esc(user.email)}</span><div class="initial">${esc(user.email[0] || '?')}</div><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></div></div>
<nav class="tabbar" aria-label="Sections"><div class="in">${tabBtns}</div></nav>
<main class="shell">${screens}</main>
<div class="sheet-bg" id="sheetBg"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div><div id="sheetBody"></div></div></div>
<div class="toast" id="toast" role="status"></div>
<script>
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,body){const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
let j={};try{j=await r.json()}catch(e){}if(r.status===401)location='/login';if(!r.ok)throw new Error(j.error||('Something went wrong ('+r.status+')'));return j}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('on');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('on'),2400)}
function sheet(html){$('sheetBody').innerHTML=html;$('sheetBg').classList.add('on')}
function closeSheet(){$('sheetBg').classList.remove('on')}
$('sheetBg').addEventListener('click',(e)=>{if(e.target.id==='sheetBg')closeSheet()});
function ask(title,text,okLabel,danger){return new Promise((res)=>{sheet('<h3>'+esc(title)+'</h3><p class="muted" style="margin:0 0 6px">'+esc(text)+'</p><div class="btnrow"><button class="soft" data-a="no">Cancel</button><button class="'+(danger?'danger':'')+'" data-a="yes">'+esc(okLabel)+'</button></div>');
  $('sheetBody').onclick=(e)=>{const b=e.target.closest('[data-a]');if(!b)return;$('sheetBody').onclick=null;closeSheet();res(b.dataset.a==='yes')}})}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('Copied')}catch(e){const t=document.createElement('textarea');t.value=text;t.setAttribute('readonly','');t.style.cssText='position:fixed;top:0;left:0;opacity:0';document.body.appendChild(t);t.select();t.setSelectionRange(0,99999);let ok=false;try{ok=document.execCommand('copy')}catch(_){}t.remove();if(ok)toast('Copied');else prompt('Copy this:',text)}}
async function logout(){if(!await ask('Log out?','You will need your email and password to log back in. Your bot keeps running while you are logged out.','Log out',true))return;try{await api('/api/logout',{})}catch(e){}location='/login'}
const ME=${JSON.stringify({ email: user.email, admin: !!user.isAdmin, page: title }).replace(/</g, '\\u003c')};
function openMenu(){const I=ICONS,L=[];
  L.push('<a href="/dashboard#home" class="'+(ME.page==='Dashboard'?'here':'')+'">'+I.home+'My dashboard</a>');
  L.push('<a href="/dashboard#account">'+I.key+'Change password</a>');
  if(ME.admin)L.push('<a href="/admin#overview" class="'+(ME.page==='Admin'?'here':'')+'">'+I.shield+'Admin page</a>');
  L.push('<a href="/">'+I.info+'About this service</a>');
  L.push('<button class="out" id="menuOut">'+I.logout+'Log out</button>');
  sheet('<div class="menu-who"><div class="initial">'+esc(ME.email[0]||'?')+'</div><div><b>'+esc(ME.email)+'</b><small>'+(ME.admin?'Admin account':'Member')+'</small></div></div><div class="menu-list">'+L.join('')+'</div>');
  $('menuOut').onclick=()=>{closeSheet();setTimeout(logout,180)};
  $('sheetBody').querySelectorAll('.menu-list a').forEach((a)=>a.addEventListener('click',()=>{closeSheet();const u=new URL(a.href);if(u.pathname===location.pathname&&u.hash){location.hash=u.hash}}))}
$('meBtn').addEventListener('click',openMenu);
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeSheet()});
function show(id){document.querySelectorAll('.screen').forEach((s)=>s.classList.toggle('on',s.id==='s-'+id));
  document.querySelectorAll('.tab[data-tab]').forEach((t)=>{const on=t.dataset.tab===id;t.classList.toggle('on',on);if(on)t.setAttribute('aria-current','page');else t.removeAttribute('aria-current')});
  if(location.hash!=='#'+id)history.replaceState(null,'','#'+id);window.scrollTo(0,0);if(window.onShow)window.onShow(id)}
document.querySelectorAll('.tab[data-tab]').forEach((t)=>t.addEventListener('click',()=>show(t.dataset.tab)));
window.addEventListener('hashchange',()=>{const h=location.hash.slice(1);if(h&&document.getElementById('s-'+h))show(h)});
const ICONS=${JSON.stringify(Object.fromEntries(Object.keys(ICONS).map((k) => [k, icon(k)])))};
(${client.toString()})();
show((location.hash||'').slice(1)&&document.getElementById('s-'+location.hash.slice(1))?location.hash.slice(1):'${initial}');
${PW_JS}
</script></body></html>`;
}

// ================= user dashboard =================
function dashboard(user) {
  const tabs = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'settings', label: 'Settings', icon: 'sliders' },
    { id: 'activity', label: 'Activity', icon: 'pulse' },
    { id: 'account', label: 'Account', icon: 'user' },
  ];
  if (user.isAdmin) tabs.push({ href: '/admin', label: 'Admin', icon: 'shield' });
  const screens = `
<section class="screen" id="s-home">
  <h1>Home</h1><p class="lead">Your WhatsApp connection and what came back.</p>
  <div class="card" id="statusCard"><div class="hero-status st-wait" id="hero"><div class="pulse"><i></i></div><div><div class="big" id="stTitle">Loading…</div><div class="sub" id="stSub"></div></div></div><div id="linkArea"></div></div>
  <div class="group"><h2>Recovered so far</h2><div class="stat-grid four" id="stats"></div></div>
  <div class="group"><h2>Commands you can send in WhatsApp</h2><div class="card" style="padding:4px 18px">
    <div class="cmd-row"><code>.vv</code><span>Reply to a view-once. It comes to your own chat.</span></div>
    <div class="cmd-row"><code>.vvc</code><span>Reply to a view-once. It's posted back in that chat.</span></div>
    <div class="cmd-row"><code>.transcribe</code><span>Reply to a voice note. Its text comes to your own chat.</span></div>
    <div class="cmd-row"><code>.block</code><span>Reply to someone. Nothing of theirs is recovered. <b>.unblock</b> undoes it.</span></div>
    <div class="cmd-row"><code>.ping</code><span>Check the bot is online.</span></div>
    <div class="cmd-row"><code>.ad</code><span>Turn recovery on or off for one chat. Send <b>.help</b> for everything.</span></div>
  </div></div>
</section>

<section class="screen" id="s-settings">
  <h1>Settings</h1><p class="lead">These apply to every chat. To change just one chat, send <b>.ad off</b> inside it.</p>
  <div class="group"><h2>Where to recover from</h2><div class="rows" id="setWhere"></div></div>
  <div class="group"><h2>What to recover</h2><div class="rows" id="setWhat"></div></div>
  <div class="group"><h2>Extras</h2><div class="rows" id="setExtra"></div></div>
</section>

<section class="screen" id="s-activity">
  <h1>Activity</h1><p class="lead">Everything the bot did, newest first. If something didn't arrive, the reason is here.</p>
  <div class="chips" id="logChips"></div>
  <div class="feed" id="log"></div>
</section>

<section class="screen" id="s-account">
  <h1>Account</h1><p class="lead">Signed in as <b>${esc(user.email)}</b></p>
  <div class="group"><h2>Change password</h2><div class="card">
    <label for="pw0" style="margin-top:0">Current password</label><input id="pw0" type="password" autocomplete="current-password">
    <label for="pw1">New password <small>· at least 8 characters</small></label><input id="pw1" type="password" autocomplete="new-password">
    <label for="pw2">Repeat new password</label><input id="pw2" type="password" autocomplete="new-password">
    <button class="wide-btn" id="pwBtn">Change password</button><div class="err" id="pwErr" role="alert"></div>
  </div></div>
  <div class="group"><button class="light wide-btn" id="logoutBtn">${icon('logout')} Log out</button></div>
</section>`;
  return appLayout('Dashboard', user, tabs, screens, dashClient, 'home');
}

function dashClient() {
  const LABELS = {
    enabled: ['setWhere', 'Recovery', 'Master switch. Off pauses everything.'],
    privateChats: ['setWhere', 'Private chats', 'One-to-one chats'],
    groups: ['setWhere', 'Groups', 'All group chats'],
    statusDeleted: ['setWhere', 'Deleted statuses', 'WhatsApp statuses someone deleted'],
    statusEdited: ['setWhere', 'Edited statuses', 'WhatsApp statuses someone edited, before and after'],
    text: ['setWhat', 'Text', 'Deleted and edited messages'],
    image: ['setWhat', 'Photos', ''], video: ['setWhat', 'Videos', ''], audio: ['setWhat', 'Voice notes and audio', ''],
    sticker: ['setWhat', 'Stickers', ''], document: ['setWhat', 'Documents', ''],
    viewOnce: ['setExtra', 'View-once, automatically', 'WhatsApp often hides these from linked devices. Replying .vv always works.'],
    saveMediaAhead: ['setExtra', 'Save media as it arrives', 'Needed to recover deleted photos and videos'],
  };
  const MAP = { connected: ['ok', 'Connected'], waiting_link: ['wait', 'Waiting for you to link'], starting: ['wait', 'Starting…'], reconnecting: ['wait', 'Reconnecting…'],
    stopped: ['off', 'Not linked yet'], logged_out: ['off', 'Logged out by WhatsApp'], error: ['off', 'Stopped'] };
  let last = null; let logFilter = 'all'; let busy = false;

  // build settings rows once
  for (const k of Object.keys(LABELS)) {
    const [box, t, s] = LABELS[k];
    $(box).insertAdjacentHTML('beforeend', '<div class="rowi" id="r_' + k + '"><label for="s_' + k + '" style="margin:0;cursor:pointer"><span class="t">' + t + '</span>' + (s ? '<small>' + s + '</small>' : '') +
      '</label><span class="sw"><input type="checkbox" id="s_' + k + '" data-k="' + k + '"><span></span></span></div>');
  }
  document.querySelectorAll('.sw input[data-k]').forEach((el) => el.addEventListener('change', async () => {
    try { await api('/api/me/settings', { [el.dataset.k]: el.checked }); toast((LABELS[el.dataset.k][1]) + (el.checked ? ' on' : ' off')); }
    catch (e) { el.checked = !el.checked; toast(e.message); }
    dimRows();
  }));
  function dimRows() { const on = $('s_enabled').checked; for (const k in LABELS) if (k !== 'enabled') $('r_' + k).classList.toggle('dim', !on); }

  $('logChips').innerHTML = [['all', 'All'], ['error', 'Problems'], ['info', 'Recovered']].map(([k, l]) => '<button class="chip' + (k === 'all' ? ' on' : '') + '" data-f="' + k + '">' + l + '</button>').join('');
  $('logChips').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (!b) return; logFilter = b.dataset.f;
    $('logChips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b)); renderLog(); });

  function fmt(t) { const d = new Date(t); const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }); }
  function renderLog() {
    if (!last) return;
    let l = last.log.slice().reverse();
    if (logFilter === 'error') l = l.filter((x) => x.level !== 'info');
    if (logFilter === 'info') l = l.filter((x) => /Recovered|Saved|sent a|\.vv/i.test(x.msg));
    const ic = { info: '✓', warn: '!', error: '✕' };
    $('log').innerHTML = l.length ? l.map((x) => '<div class="ev ' + x.level + '"><span class="ic">' + (ic[x.level] || '•') + '</span><div><span class="msg">' + esc(x.msg) + '</span><time>' + fmt(x.t) + '</time></div></div>').join('')
      : '<div class="empty"><b>' + (logFilter === 'error' ? 'No problems' : 'Nothing here yet') + '</b>' + (logFilter === 'error' ? 'Everything is working.' : 'Activity shows up once WhatsApp is linked.') + '</div>';
  }

  function tile(icn, label, action, cls) { return '<button class="tile ' + (cls || '') + '" data-act="' + action + '">' + ICONS[icn] + '<span>' + label + '</span></button>'; }
  function renderStatus(s) {
    const st = s.session.state; const [cls, txt] = MAP[st] || ['wait', st];
    $('hero').className = 'hero-status st-' + cls; $('stTitle').textContent = txt;
    $('stSub').textContent = s.session.me ? '+' + s.session.me : (st === 'logged_out' ? 'Link again to keep recovering.' : st === 'stopped' ? 'Link your WhatsApp to start.' : '');
    let h = '';
    if (st === 'connected' || st === 'reconnecting' || st === 'starting') {
      h = '<div class="actions">' + tile('wrench', 'Fix stuck messages', 'fix') + tile('refresh', 'Restart', 'restart') + tile('unlink', 'Unlink', 'unlink', 'danger') + '</div>';
    } else if (st === 'waiting_link') {
      if (s.session.pairingCode) h += '<p style="margin:16px 0 0">In WhatsApp: <b>Settings → Linked devices → Link a device → Link with phone number instead</b>, then type this code:</p><button type="button" class="code-big code-tap" data-copy="' + esc(s.session.pairingCode) + '" aria-label="Copy code">' + esc(s.session.pairingCode) + '</button><button type="button" class="wide-btn" data-copy="' + esc(s.session.pairingCode) + '">' + ICONS.copy + ' Copy code</button><p class="muted small" style="margin:8px 0 0;text-align:center">Tap to copy, then paste it in WhatsApp. The code changes every minute or so.</p>';
      if (s.session.qr) h += '<p class="muted" style="margin:12px 0 6px">' + (s.session.pairingCode ? 'Or scan' : 'Scan') + ' this from WhatsApp → Linked devices:</p><img class="qr" alt="QR code to link WhatsApp" src="' + s.session.qr + '">';
      if (!h) h = '<p class="muted" style="margin:14px 0 0">Getting your code…</p>';
      h += '<button class="soft wide-btn" data-act="stop">Cancel</button>';
    } else {
      h = '<label for="phone">Your WhatsApp number, with country code</label><input id="phone" inputmode="numeric" autocomplete="tel" placeholder="2348012345678"><div class="hint">Leave it empty to get a QR code instead.</div><button class="wide-btn" data-act="link">' + ICONS.link + ' Link WhatsApp</button>';
    }
    const box = $('linkArea'); if (box.dataset.h !== h && !(document.activeElement && document.activeElement.id === 'phone')) { box.innerHTML = h; box.dataset.h = h; }
    const x = s.session.stats;
    $('stats').innerHTML = [['Deleted', x.deleted], ['Edited', x.edited], ['View-once', x.viewOnce + x.vv], ['Problems', x.errors]].map(([a, b]) => '<div class="stat"><b>' + b + '</b><span>' + a + '</span></div>').join('');
  }

  $('linkArea').addEventListener('click', (e) => { const c = e.target.closest('[data-copy]'); if (c) { e.stopPropagation(); copy(c.dataset.copy.replace(/[^A-Za-z0-9]/g, '')); } });
  $('linkArea').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || busy) return; const a = b.dataset.act;
    if (a === 'unlink' && !(await ask('Unlink this WhatsApp?', 'The bot stops recovering messages until you link again.', 'Unlink', true))) return;
    if (a === 'fix' && !(await ask('Fix stuck messages?', 'Use this if your own chat shows "Waiting for this message". The bot reconnects for a few seconds.', 'Fix now'))) return;
    busy = true; b.disabled = true;
    try {
      if (a === 'link') { const p = ($('phone').value || '').replace(/\D/g, ''); await api('/api/me/link', { phone: p || null }); }
      else await api({ fix: '/api/me/fix-self', restart: '/api/me/restart', unlink: '/api/me/unlink', stop: '/api/me/stop' }[a], {});
      toast({ link: 'Getting your code…', fix: 'Fixing, reconnecting now', restart: 'Restarting', unlink: 'Unlinked', stop: 'Cancelled' }[a]);
    } catch (err) { toast(err.message); }
    busy = false; refresh();
  });

  async function refresh() {
    let s; try { s = await api('/api/me/status'); } catch (e) { return; }
    last = s; renderStatus(s);
    for (const k in LABELS) { const el = $('s_' + k); if (el && document.activeElement !== el) el.checked = !!s.settings[k]; }
    dimRows(); renderLog();
  }

  $('pwBtn').onclick = async () => {
    $('pwErr').textContent = '';
    if (!$('pw0').value) { $('pwErr').textContent = 'Enter your current password.'; return; }
    if ($('pw1').value.length < 8) { $('pwErr').textContent = 'New password must be at least 8 characters.'; return; }
    if ($('pw1').value !== $('pw2').value) { $('pwErr').textContent = "The two new passwords don't match."; return; }
    $('pwBtn').disabled = true;
    try { await api('/api/me/password', { current: $('pw0').value, next: $('pw1').value }); $('pw0').value = $('pw1').value = $('pw2').value = ''; toast('Password changed'); }
    catch (e) { $('pwErr').textContent = e.message; }
    $('pwBtn').disabled = false;
  };
  $('logoutBtn').onclick = logout;
  refresh(); setInterval(refresh, 3000);
}

// ================= admin =================
function admin(user) {
  const tabs = [
    { href: '/dashboard', label: 'My bot', icon: 'back' },
    { id: 'overview', label: 'Overview', icon: 'home' },
    { id: 'users', label: 'Users', icon: 'users' },
    { id: 'invites', label: 'Invites', icon: 'ticket' },
    { id: 'system', label: 'System', icon: 'server' },
  ];
  const screens = `
<section class="screen" id="s-overview">
  <h1>Admin</h1><p class="lead">Everyone using the service, at a glance.</p>
  <div class="group"><h2>Users</h2><div class="stat-grid four" id="ustats"></div></div>
  <div class="group"><h2>Needs attention</h2><div id="attention"></div></div>
  <div class="group"><h2>Server</h2><div class="stat-grid four" id="health"></div></div>
  <button class="wide-btn" data-go="invite">${icon('plus')} Invite someone</button>
</section>

<section class="screen" id="s-users">
  <h1>Users</h1><p class="lead">Tap Manage account to disable, reset or delete someone.</p>
  <div class="search">${icon('search')}<input id="q" type="search" placeholder="Search by email or number" autocomplete="off"></div>
  <div class="chips" id="uChips"></div>
  <div id="users"></div>
</section>

<section class="screen" id="s-invites">
  <h1>Invites</h1><p class="lead">Each code works once. Requests from the website show up here too.</p>
  <button class="wide-btn" data-go="invite" style="margin:4px 0 16px">${icon('plus')} New invite code</button>
  <div class="chips" id="iChips"></div>
  <div id="invites"></div>
</section>

<section class="screen" id="s-system">
  <h1>System</h1><p class="lead">Alerts, backups, keys and updates.</p>
  <div class="group"><h2>Alerts</h2><div class="rows" id="alertSet"></div>
  <p class="hint" style="margin:8px 4px 0">Sent from your WhatsApp to your own chat, at most once every 6 hours per problem.</p></div>
  <div class="group"><h2>Backups</h2><div class="rows" id="backupSet"></div>
  <p class="hint" style="margin:8px 4px 0">Once a day the server saves one file with every account, invite and WhatsApp login (not photos or videos). It replaces the previous one. If this server dies, that file moves everyone to a new server without relinking.</p>
  <button class="wide-btn" id="bkBtn">${icon('download')} Back up now</button><div class="err" id="bkMsg"></div>
  <div id="backups" style="margin-top:12px"></div></div>
  <div class="group"><h2>Keys and updates</h2><div class="card" style="padding:16px 18px">
    <label for="kGem" style="display:block;font-weight:600">Gemini API key <small id="kGemSt" class="muted"></small></label>
    <p class="hint" style="margin:2px 0 8px">For <b>.transcribe</b>. Free from aistudio.google.com/apikey.</p>
    <input id="kGem" type="password" autocomplete="off" placeholder="Paste to set or replace" style="width:100%">
    <label for="kTok" style="display:block;font-weight:600;margin-top:14px">GitHub update token <small id="kTokSt" class="muted"></small></label>
    <p class="hint" style="margin:2px 0 8px">Lets the server download new versions from your private repo by itself.</p>
    <input id="kTok" type="password" autocomplete="off" placeholder="Paste to set or replace" style="width:100%">
    <button class="wide-btn" id="kSave" style="margin-top:14px">Save keys</button><div class="err" id="kMsg"></div>
    <p class="hint" style="margin:10px 0 0">Keys are stored only on this server and never shown again. Version: <b id="kRel">?</b></p>
    <div id="kLog" class="hint" style="margin-top:6px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12.5px"></div>
  </div></div>
</section>`;
  return appLayout('Admin', user, tabs, screens, adminClient, 'overview');
}

function adminClient() {
  const STATE = { connected: ['ok', 'Online'], waiting_link: ['wait', 'Linking'], reconnecting: ['wait', 'Reconnecting'], starting: ['wait', 'Starting'],
    stopped: ['off', 'Stopped'], 'not linked': ['off', 'Not linked'], logged_out: ['rev', 'Logged out'], error: ['rev', 'Stopped'] };
  const IST = { unused: ['ok', 'Unused'], used: ['used', 'Used'], revoked: ['rev', 'Revoked'] };
  const RST = { pending: ['wait', 'Waiting'], sent: ['ok', 'Code sent'], approved: ['used', 'Not delivered'], declined: ['rev', 'Declined'] };
  let data = null; let uFilter = 'all'; let iFilter = 'requests'; let iTouched = false;
  const day = (t) => t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';
  const userState = (u) => u.disabled ? ['rev', 'Disabled'] : (STATE[u.state] || ['off', u.state]);

  function chips(el, list, cur, cb) {
    el.innerHTML = list.map(([k, l, n]) => '<button class="chip' + (k === cur ? ' on' : '') + '" data-f="' + k + '">' + l + (n !== undefined ? '<b>' + n + '</b>' : '') + '</button>').join('');
    el.onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) cb(b.dataset.f); };
  }

  function renderOverview() {
    const h = data.health;
    $('ustats').innerHTML = [[h.users + '<small style="font-size:16px;color:var(--ink2)"> / ' + h.maxUsers + '</small>', 'Users'], [h.connected, 'Online now'], [h.notLinked, 'Not linked yet'], [h.invitesUnused, 'Unused invites']]
      .map(([b, a]) => '<div class="stat"><b>' + b + '</b><span>' + a + '</span></div>').join('');
    $('health').innerHTML = [[h.uptime, 'Running for'], [h.rssMb + ' MB', 'App memory'], [(h.freeMemMb / 1024).toFixed(1) + ' GB', 'Memory free'], [h.diskFreeGb + ' GB', 'Disk free']]
      .map(([b, a]) => '<div class="stat"><b style="font-size:22px">' + esc(b) + '</b><span>' + a + '</span></div>').join('');
    const bad = data.users.filter((u) => !u.isAdmin && (u.state === 'logged_out' || u.state === 'error' || u.errors > 0));
    $('attention').innerHTML = bad.length ? bad.map((u) => { const [c, t] = userState(u);
      return '<div class="item"><div class="item-head"><div><div class="name">' + esc(u.email) + '</div><div class="when">' + (u.errors ? u.errors + ' problem' + (u.errors > 1 ? 's' : '') : 'Needs to relink') + '</div></div><span class="tag ' + c + '">' + t + '</span></div></div>'; }).join('')
      : (h.requestsPending ? '' : '<div class="card empty" style="padding:20px"><b>All good</b>Nobody needs help right now.</div>');
    if (h.requestsPending) $('attention').insertAdjacentHTML('afterbegin', '<a class="item" href="#invites" data-reqlink style="display:block;text-decoration:none;color:inherit"><div class="item-head"><div><div class="name">' + h.requestsPending + ' invite request' + (h.requestsPending > 1 ? 's' : '') + '</div><div class="when">Tap to approve or decline</div></div><span class="tag wait">Waiting</span></div></a>');
  }

  function renderUsers() {
    const q = ($('q').value || '').toLowerCase();
    const counts = { all: data.users.length, online: data.users.filter((u) => u.state === 'connected').length,
      off: data.users.filter((u) => u.state !== 'connected' && !u.disabled).length, disabled: data.users.filter((u) => u.disabled).length };
    chips($('uChips'), [['all', 'All', counts.all], ['online', 'Online', counts.online], ['off', 'Not online', counts.off], ['disabled', 'Disabled', counts.disabled]], uFilter, (f) => { uFilter = f; renderUsers(); });
    let list = data.users.filter((u) => !q || u.email.toLowerCase().includes(q) || String(u.phone || '').includes(q));
    if (uFilter === 'online') list = list.filter((u) => u.state === 'connected');
    if (uFilter === 'off') list = list.filter((u) => u.state !== 'connected' && !u.disabled);
    if (uFilter === 'disabled') list = list.filter((u) => u.disabled);
    $('users').innerHTML = list.length ? list.map((u) => { const [c, t] = userState(u);
      const acts = u.isAdmin ? '' : '<button class="soft manage" data-manage="' + u.id + '">Manage account</button>';
      return '<div class="item"><div class="item-head"><div style="min-width:0"><div class="name">' + esc(u.email) + (u.isAdmin ? ' <span class="tag used">You · admin</span>' : '') +
        '</div><div class="when">Joined ' + day(u.createdAt) + '</div></div><span class="tag ' + c + '">' + t + '</span></div>' +
        '<div class="facts"><div><span>WhatsApp</span><b>' + (u.phone ? '+' + esc(u.phone) : '—') + '</b></div><div><span>Recovered</span><b>' + (u.recovered || 0) + '</b></div><div><span>Problems</span><b' + (u.errors ? ' style="color:var(--bad)"' : '') + '>' + u.errors + '</b></div></div>' + acts + '</div>'; }).join('')
      : '<div class="card empty"><b>No matches</b>Try another search or filter.</div>';
  }
  $('q').addEventListener('input', renderUsers);
  $('users').addEventListener('click', (e) => {
    const m = e.target.closest('[data-manage]'); if (!m) return;
    const u = data.users.find((x) => x.id === m.dataset.manage); if (!u) return;
    sheet('<h3 style="overflow-wrap:anywhere">' + esc(u.email) + '</h3><p class="muted" style="margin:0">' + (u.phone ? 'WhatsApp +' + esc(u.phone) : 'WhatsApp not linked') + ' · joined ' + day(u.createdAt) + '</p><div class="opts">' +
      (u.disabled ? '<button class="soft" data-u="enable" data-id="' + u.id + '"><span class="lbl">Enable account<small>They can log in and their bot starts again</small></span></button>'
        : '<button class="soft" data-u="disable" data-id="' + u.id + '"><span class="lbl">Disable account<small>Stops their bot and blocks login, nothing is deleted</small></span></button>') +
      '<button class="soft" data-u="reset-password" data-id="' + u.id + '"><span class="lbl">Give a new password<small>For when they forget theirs</small></span></button>' +
      '<button class="danger" data-u="delete" data-id="' + u.id + '" data-email="' + esc(u.email) + '"><span class="lbl">Delete account<small style="color:var(--bad)">Removes everything. Can\u2019t be undone</small></span></button>' +
      '<button class="light" onclick="closeSheet()">Cancel</button></div>');
  });
  $('sheetBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-u]'); if (!b) return; const a = b.dataset.u; closeSheet();
    if (a === 'delete' && !(await ask('Delete ' + b.dataset.email + '?', 'Their account, WhatsApp link and saved data are removed. This can’t be undone.', 'Delete', true))) return;
    if (a === 'disable' && !(await ask('Disable this account?', 'Their bot stops and they can’t log in until you enable it again.', 'Disable'))) return;
    b.disabled = true;
    try {
      const r = await api('/api/admin/users/' + b.dataset.id + '/' + a, {});
      if (r.tempPassword) sheet('<h3>New password</h3><p class="muted" style="margin:0">Send this to them and ask them to change it after logging in.</p><div class="code-big" style="font-size:26px;letter-spacing:1px">' + esc(r.tempPassword) + '</div><div class="btnrow"><button class="soft" onclick="copy(' + JSON.stringify(r.tempPassword).replace(/"/g, '&quot;') + ')">' + ICONS.copy + ' Copy</button><button onclick="closeSheet()">Done</button></div>');
      else toast({ enable: 'Enabled', disable: 'Disabled', delete: 'Deleted' }[a] || 'Done');
    } catch (err) { toast(err.message); }
    load();
  });

  function inviteLink(code) { return location.origin + '/signup?invite=' + code; }
  function shareBtns(code, phone) {
    const msg = 'You’re invited to WA Recovery. Sign up here: ' + inviteLink(code) + ' (invite code: ' + code + ')';
    return '<div class="inv-actions"><button class="soft" data-copy="' + esc(inviteLink(code)) + '">' + ICONS.copy + ' Copy</button><a class="btn" href="https://wa.me/' + (phone ? esc(phone) : '') + '?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener">' + ICONS.share + ' WhatsApp</a></div>';
  }
  function renderInvites() {
    const reqs = data.requests || [];
    const pend = reqs.filter((r) => r.status === 'pending').length;
    if (!iTouched && !pend && iFilter === 'requests') iFilter = 'unused';
    const by = (s) => data.invites.filter((i) => i.status === s).length;
    chips($('iChips'), [['requests', 'Requests', pend], ['unused', 'Unused', by('unused')], ['used', 'Used', by('used')], ['revoked', 'Revoked', by('revoked')]], iFilter, (f) => { iFilter = f; iTouched = true; renderInvites(); });
    if (iFilter === 'requests') {
      const list = reqs.slice().reverse().slice(0, 60);
      $('invites').innerHTML = list.length ? list.map((r) => { const [c, t] = RST[r.status] || ['off', r.status];
        return '<div class="item"><div class="item-head"><div><div class="name">' + esc(r.name || 'No name') + '</div><div class="when">+' + esc(r.phone) + ' · ' + day(r.createdAt) + '</div></div><span class="tag ' + c + '">' + t + '</span></div>' +
          (r.status === 'pending' ? '<div class="inv-actions"><button class="soft" data-rq="decline" data-id="' + esc(r.id) + '">Decline</button><button data-rq="approve" data-id="' + esc(r.id) + '">' + ICONS.share + ' Approve &amp; send</button></div>' : '') +
          (r.status === 'approved' && r.code ? '<p class="muted small" style="margin:10px 0 0">Couldn’t send it on WhatsApp' + (r.sendError ? ' (' + esc(r.sendError) + ')' : '') + '. Send the code yourself:</p>' + shareBtns(r.code, r.phone) : '') +
          (r.status === 'sent' && r.code ? '<div class="when" style="margin-top:8px">Code ' + esc(r.code) + '</div>' : '') + '</div>'; }).join('')
        : '<div class="card empty"><b>No requests yet</b>People without a code can ask for one at /request. They’ll show up here.</div>';
      return;
    }
    const list = data.invites.filter((i) => i.status === iFilter).slice().reverse();
    $('invites').innerHTML = list.length ? list.map((i) => { const [c, t] = IST[i.status];
      return '<div class="item"><div class="item-head"><div><div class="codeline"><span class="code">' + esc(i.code) + '</span></div><div class="when">' + (i.note ? 'For ' + esc(i.note) + ' · ' : '') + day(i.createdAt) + '</div></div><span class="tag ' + c + '">' + t + '</span></div>' +
        (i.status === 'used' ? '<div class="facts" style="grid-template-columns:1fr"><div><span>Used by</span><b>' + esc(i.usedBy.join(', ')) + '</b></div></div>' : '') +
        (i.status === 'unused' ? shareBtns(i.code) + '<button class="linkbtn" data-rv="' + esc(i.code) + '">Revoke this code</button>' : '') + '</div>'; }).join('')
      : '<div class="card empty"><b>' + (iFilter === 'unused' ? 'No unused invites' : 'Nothing here') + '</b>' + (iFilter === 'unused' ? 'Tap New invite to add someone.' : '') + '</div>';
  }
  document.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]'); if (c) { copy(c.dataset.copy); return; }
    const r = e.target.closest('[data-rv]');
    if (r) { if (!(await ask('Revoke ' + r.dataset.rv + '?', 'The code stops working. Nobody has used it yet.', 'Revoke', true))) return;
      try { await api('/api/admin/invites/revoke', { code: r.dataset.rv }); toast('Revoked'); } catch (err) { toast(err.message); } load(); return; }
    if (e.target.closest('[data-reqlink]')) { iFilter = 'requests'; iTouched = true; setTimeout(renderInvites, 0); }
    const q = e.target.closest('[data-rq]');
    if (q) {
      const r = (data.requests || []).find((x) => x.id === q.dataset.id); if (!r) return;
      if (q.dataset.rq === 'decline') {
        if (!(await ask('Decline this request?', (r.name || 'This person') + ' (+' + r.phone + ') won’t get a code. They aren’t told.', 'Decline', true))) return;
        try { await api('/api/admin/requests/' + r.id + '/decline', {}); toast('Declined'); } catch (err) { toast(err.message); } load(); return;
      }
      q.disabled = true; q.textContent = 'Sending…';
      try { const x = await api('/api/admin/requests/' + r.id + '/approve', {});
        if (x.sent) toast('Code sent to +' + r.phone);
        else sheet('<h3>Code made, not sent</h3><p class="muted" style="margin:0">Your WhatsApp couldn’t send it (' + esc(x.error || 'unknown') + '). Send it yourself:</p><div class="code-big">' + esc(x.code) + '</div>' + shareBtns(x.code, r.phone) + '<button class="light wide-btn" onclick="closeSheet()">Done</button>');
      } catch (err) { toast(err.message); }
      load(); return;
    }
    const g = e.target.closest('[data-go="invite"]'); if (g) newInvite();
  });
  function newInvite() {
    sheet('<h3>Invite someone</h3><p class="muted" style="margin:0">They’ll get a one-time code to create their account.</p><label for="note">Who is it for? <small>· optional</small></label><input id="note" placeholder="Tolu from class" autocomplete="off"><div class="btnrow"><button class="soft" onclick="closeSheet()">Cancel</button><button id="mkInv">Create code</button></div>');
    setTimeout(() => $('note').focus(), 50);
    $('mkInv').onclick = async () => {
      const who = $('note').value.trim();
      try { const r = await api('/api/admin/invites', { note: who });
        sheet('<h3>Invite ready</h3><p class="muted" style="margin:0">Send this to ' + (esc(who) || 'them') + '. It works once.</p><div class="code-big">' + esc(r.code) + '</div>' + shareBtns(r.code) + '<button class="light wide-btn" onclick="closeSheet()">Done</button>');
        iFilter = 'unused'; load();
      } catch (err) { toast(err.message); }
    };
  }

  const ASET = { alerts: ['Alert me when something breaks', 'Someone is logged out by WhatsApp, offline for 10+ minutes, or hitting lots of errors'], alertUsers: ['Also tell the user', 'Sends them a WhatsApp message from your number when WhatsApp logs them out'] };
  ASET.autoInvite = ['Send codes to requests automatically', 'Anyone who asks on the website gets a code straight away, with no approval. Leave off to approve each one.'];
  const BSET = { backupToWhatsApp: ['Send each backup to my WhatsApp', 'Keeps a copy off the server. It holds everyone’s WhatsApp login, so never forward it.'] };
  function sw(k, l, on) { return '<div class="rowi"><label for="a_' + k + '" style="margin:0;cursor:pointer"><span class="t">' + l[0] + '</span><small>' + l[1] + '</small></label><span class="sw"><input type="checkbox" id="a_' + k + '" data-a="' + k + '"' + (on ? ' checked' : '') + '><span></span></span></div>'; }
  async function loadExtras() {
    const d = await api('/api/admin/extras');
    $('alertSet').innerHTML = Object.keys(ASET).map((k) => sw(k, ASET[k], d.settings[k])).join('');
    $('backupSet').innerHTML = Object.keys(BSET).map((k) => sw(k, BSET[k], d.settings[k])).join('');
    $('backups').innerHTML = d.backups.length ? d.backups.map((b) => '<div class="item"><div class="item-head"><div><div class="name">' + esc(new Date(b.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</div><div class="when">' + b.sizeKb + ' KB</div></div><a class="btn soft" style="padding:10px 14px;font-size:14px" href="/api/admin/backup/' + encodeURIComponent(b.name) + '">' + ICONS.download + ' Download</a></div></div>').join('')
      : '<div class="card empty"><b>No backup yet</b>The first one runs a few minutes after the server starts.</div>';
    $('bkMsg').textContent = d.last && !d.last.ok ? 'Last backup failed: ' + d.last.error : '';
  }
  document.addEventListener('change', async (e) => { const el = e.target.closest('input[data-a]'); if (!el) return;
    try { await api('/api/admin/settings', { [el.dataset.a]: el.checked }); toast('Saved'); } catch (err) { el.checked = !el.checked; toast(err.message); } });
  $('bkBtn').onclick = async () => { const b = $('bkBtn'); b.disabled = true; $('bkMsg').textContent = '';
    try { const r = await api('/api/admin/backup', {}); toast(r.warning || ('Backup saved' + (r.sentToWhatsApp ? ' and sent to your WhatsApp' : ''))); } catch (err) { $('bkMsg').textContent = err.message; }
    b.disabled = false; loadExtras(); };

  async function loadKeys() {
    try { const k = await api('/api/admin/keys');
      $('kGemSt').textContent = k.set.gemini ? '· set ✓' : '· not set'; $('kTokSt').textContent = k.set.updateToken ? '· set ✓' : '· not set';
      $('kRel').textContent = k.release || 'manual install'; $('kLog').textContent = (k.updateLog || []).join('\n');
    } catch (e) {}
  }
  $('kSave').onclick = async () => {
    const body = {}; if ($('kGem').value.trim()) body.gemini = $('kGem').value; if ($('kTok').value.trim()) body.updateToken = $('kTok').value;
    if (!Object.keys(body).length) { $('kMsg').textContent = 'Paste a key first.'; return; }
    try { await api('/api/admin/keys', body); $('kGem').value = ''; $('kTok').value = ''; $('kMsg').textContent = ''; toast('Keys saved'); loadKeys(); }
    catch (err) { $('kMsg').textContent = err.message; }
  };
  loadKeys();
  async function load() { try { data = await api('/api/admin/overview'); } catch (e) { return; } renderOverview(); renderUsers(); renderInvites(); }
  load(); loadExtras(); setInterval(load, 10000);
}

module.exports = { landing, authForm, requestInvite, dashboard, admin, esc };
