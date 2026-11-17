// Entry point: web server (landing, accounts, dashboard, admin) + all users' WhatsApp sessions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const cfg = require('./src/config');
const db = require('./src/db');
const auth = require('./src/auth');
const ud = require('./src/userdata');
const media = require('./src/media');
const sessions = require('./src/sessions');
const pages = require('./src/pages');
const backup = require('./src/backup');
const adminSettings = require('./src/adminsettings');
const alerts = require('./src/alerts');

const app = express();
app.set('trust proxy', true);           // behind Vercel / a reverse proxy
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(auth.attachUser);
app.use((req, res, next) => {           // basic security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// Every state-changing request must be JSON. Browsers can't send cross-site JSON without
// permission, so together with SameSite cookies this blocks CSRF.
app.use((req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Bad request.' });
  next();
});

const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '')) && String(e).length <= 120;
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[web]', req.method, req.path, e);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

// ---------- pages ----------
app.get('/', (req, res) => res.send(pages.landing(req.user)));
app.get('/login', (req, res) => (req.user ? res.redirect('/dashboard') : res.send(pages.authForm('login'))));
app.get('/signup', (req, res) => (req.user ? res.redirect('/dashboard') : res.send(pages.authForm('signup'))));
app.get('/request', (req, res) => (req.user ? res.redirect('/dashboard') : res.send(pages.requestInvite())));
app.get('/dashboard', auth.requireLogin, (req, res) => res.send(pages.dashboard(req.user)));
app.get('/admin', auth.requireLogin, auth.requireAdmin, (req, res) => res.send(pages.admin(req.user)));
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ---------- invite requests ----------
/** Digits only, with country code. A Nigerian number typed as 080... becomes 23480... */
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = '234' + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : null;
}
const reqHits = new Map(); // ip -> [times]
function tooManyRequests(ip) {
  const now = Date.now(), list = (reqHits.get(ip) || []).filter((t) => now - t < 3600e3);
  list.push(now); reqHits.set(ip, list);
  if (reqHits.size > 5000) reqHits.clear();
  return list.length > 4;
}
function inviteMessage(name, code) {
  return `Hi${name ? ' ' + name : ''} 👋\n\nHere's your invite code for *WA Recovery*:\n\n*${code}*\n\nSign up here: ${cfg.PUBLIC_URL}/signup?invite=${code}\n\nThe code works once.`;
}
/** Make a code for a request and send it on WhatsApp. Returns { code, sent, error }. */
async function grantRequest(r, byUser) {
  const inv = db.createInvite({ note: `${r.name || 'Request'} (+${r.phone})`, createdBy: byUser });
  try {
    await alerts.sendToNumber(r.phone, inviteMessage(r.name, inv.code));
    db.updateRequest(r.id, { status: 'sent', code: inv.code });
    return { code: inv.code, sent: true };
  } catch (e) {
    db.updateRequest(r.id, { status: 'approved', code: inv.code, sendError: e.message });
    return { code: inv.code, sent: false, error: e.message };
  }
}
app.post('/api/request-invite', wrap(async (req, res) => {
  if (tooManyRequests(req.ip)) return res.status(429).json({ error: 'Too many requests. Try again in an hour.' });
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const phone = normPhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Enter your WhatsApp number with country code, like 2348012345678.' });
  if (db.listUsers().some((u) => u.phone === phone)) return res.status(400).json({ error: 'That number already has an account. Log in instead.' });
  if (db.listUsers().length >= cfg.MAX_USERS) return res.status(400).json({ error: 'The service is full right now. Try again later.' });
  if (db.pendingRequestFor(phone)) return res.json({ ok: true, status: 'pending', phone });
  const on = await alerts.isOnWhatsApp(phone);
  if (on === false) return res.status(400).json({ error: "That number isn't on WhatsApp. Check it and try again." });
  const r = db.addRequest({ name, phone });
  if (adminSettings.get().autoInvite) {
    const g = await grantRequest(r, null);
    if (g.sent) { alerts.toAdmins(`📨 Sent an invite code to ${name || 'someone'} (+${phone}) automatically.`).catch(() => {}); return res.json({ ok: true, status: 'sent', phone }); }
  }
  alerts.toAdmins(`📨 *Invite request*\n${name || 'No name'} (+${phone}) wants to join.\n\nApprove it here: ${cfg.PUBLIC_URL}/admin#invites`).catch(() => {});
  res.json({ ok: true, status: 'pending', phone });
}));

// ---------- accounts ----------
app.post('/api/signup', wrap(async (req, res) => {
  const { invite, email, password } = req.body || {};
  if (auth.tooManyFails(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  const inv = db.findInvite(invite);
  if (!inv) { auth.noteFail(req.ip); return res.status(400).json({ error: 'That invite code is wrong or already used.' }); }
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.getUserByEmail(email)) return res.status(400).json({ error: 'An account with that email already exists.' });
  if (!inv.admin && db.listUsers().length >= cfg.MAX_USERS) return res.status(400).json({ error: 'The service is full right now.' });
  const user = db.createUser({ email, passHash: await auth.hashPassword(password), isAdmin: !!inv.admin, invite: inv.code });
  db.consumeInvite(inv.code, user.id);
  if (inv.admin) { try { fs.unlinkSync(path.join(cfg.DATA_DIR, 'ADMIN_INVITE.txt')); } catch {} }
  ud.userDir(user.id);
  ud.log(user.id, 'info', 'Account created. Link your WhatsApp to start.');
  auth.clearFails(req.ip);
  auth.setLoginCookie(req, res, user);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (auth.tooManyFails(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  const user = db.getUserByEmail(email);
  const ok = user && (await auth.checkPassword(password, user.passHash));
  if (!ok) { auth.noteFail(req.ip); return res.status(401).json({ error: 'Wrong email or password.' }); }
  if (user.disabled) return res.status(403).json({ error: 'This account is disabled. Contact the admin.' });
  auth.clearFails(req.ip);
  auth.setLoginCookie(req, res, user);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { auth.clearLoginCookie(res); res.json({ ok: true }); });

// ---------- the logged-in user's own WhatsApp ----------
const me = express.Router();
me.use(auth.requireLogin);
me.get('/status', (req, res) => {
  res.json({
    session: sessions.get(req.user.id).status(),
    settings: ud.loadSettings(req.user.id).global,
    log: ud.getLog(req.user.id).slice(-80),
  });
});
me.post('/link', wrap(async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (phone && (phone.length < 8 || phone.length > 15)) return res.status(400).json({ error: 'Enter the full number with country code, digits only.' });
  const s = sessions.get(req.user.id);
  if (s.state === 'connected') return res.status(400).json({ error: 'Already connected.' });
  if (!sessions.hasAuth(req.user.id) || phone) ud.removeAuth(req.user.id); // start a clean link
  await s.start({ phone: phone || null });
  res.json({ ok: true });
}));
me.post('/stop', wrap(async (req, res) => { await sessions.get(req.user.id).stop('Linking cancelled'); res.json({ ok: true }); }));
me.post('/restart', wrap(async (req, res) => {
  const s = sessions.get(req.user.id);
  if (!sessions.hasAuth(req.user.id)) return res.status(400).json({ error: 'Link WhatsApp first.' });
  s.log('info', 'Restart requested from dashboard'); await s.start(); res.json({ ok: true });
}));
me.post('/fix-self', wrap(async (req, res) => {
  const s = sessions.get(req.user.id);
  if (s.state !== 'connected') return res.status(400).json({ error: 'Connect WhatsApp first.' });
  res.json({ ok: true, removed: await s.resetSelfSessions() });
}));
me.post('/unlink', wrap(async (req, res) => { await sessions.get(req.user.id).unlink(); res.json({ ok: true }); }));
me.post('/settings', (req, res) => res.json({ settings: ud.setGlobal(req.user.id, req.body || {}) }));
me.post('/password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!(await auth.checkPassword(current, req.user.passHash))) return res.status(400).json({ error: 'Current password is wrong.' });
  if (String(next || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const u = db.updateUser(req.user.id, { passHash: await auth.hashPassword(next), tokenVersion: (req.user.tokenVersion || 1) + 1 });
  auth.setLoginCookie(req, res, u); // stay logged in here, log out everywhere else
  res.json({ ok: true });
}));
app.use('/api/me', me);

// ---------- admin ----------
const adm = express.Router();
adm.use(auth.requireLogin, auth.requireAdmin);
function uptime(s) { const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60; return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
adm.get('/overview', (req, res) => {
  let diskFreeGb = '?';
  try { const st = fs.statfsSync(cfg.DATA_DIR); diskFreeGb = ((st.bavail * st.bsize) / 1e9).toFixed(1); } catch {}
  let mediaMb = 0;
  const users = db.listUsers().map((u) => {
    const s = sessions.all().get(u.id);
    mediaMb += media.dirSizeMb(path.join(ud.USERS_DIR, u.id, 'media'));
    return { id: u.id, email: u.email, isAdmin: u.isAdmin, disabled: u.disabled, phone: u.phone, createdAt: u.createdAt,
      state: s && (s.state !== 'stopped' || sessions.hasAuth(u.id)) ? s.state : (sessions.hasAuth(u.id) ? 'stopped' : 'not linked'), errors: s ? s.stats.errors : 0, recovered: s ? s.stats.deleted + s.stats.edited + s.stats.viewOnce + s.stats.vv : 0 };
  });
  res.json({
    users,
    requests: db.listRequests().slice(-200).map((r) => ({ id: r.id, name: r.name, phone: r.phone, status: r.status, createdAt: r.createdAt, code: r.code || null, sendError: r.sendError || null })),
    invites: db.listInvites().filter((i) => !i.admin).map((i) => ({
      code: i.code, note: i.note, createdAt: i.createdAt,
      status: i.revoked ? 'revoked' : i.usesLeft > 0 ? 'unused' : 'used',
      usedBy: (i.usedBy || []).map((id) => db.getUser(id)?.email || 'deleted account'),
    })),
    health: {
      users: users.length, connected: users.filter((u) => u.state === 'connected').length,
      notLinked: users.filter((u) => !u.phone && u.state !== 'connected').length,
      disabled: users.filter((u) => u.disabled).length,
      invitesUnused: db.listInvites().filter((i) => !i.admin && i.usesLeft > 0).length,
      requestsPending: db.listRequests().filter((r) => r.status === 'pending').length,
      maxUsers: cfg.MAX_USERS,
      rssMb: Math.round(process.memoryUsage().rss / 1048576), freeMemMb: Math.round(os.freemem() / 1048576),
      diskFreeGb, mediaMb: Math.round(mediaMb), uptime: uptime(process.uptime()),
    },
  });
});
adm.post('/invites', (req, res) => res.json(db.createInvite({ note: req.body?.note || '', createdBy: req.user.id })));
adm.post('/requests/:id/approve', wrap(async (req, res) => {
  const r = db.listRequests().find((x) => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(400).json({ error: 'That request was already handled.' });
  res.json(await grantRequest(r, req.user.id));
}));
adm.post('/requests/:id/decline', (req, res) => {
  const r = db.updateRequest(req.params.id, { status: 'declined' });
  if (!r) return res.status(404).json({ error: 'No such request.' });
  res.json({ ok: true });
});
adm.post('/invites/revoke', (req, res) => { db.revokeInvite(String(req.body?.code || '')); res.json({ ok: true }); });
adm.post('/users/:id/:action', wrap(async (req, res) => {
  const u = db.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  if (u.isAdmin) return res.status(400).json({ error: 'Admins can\'t be changed here.' });
  const a = req.params.action;
  if (a === 'disable') { db.updateUser(u.id, { disabled: true, tokenVersion: (u.tokenVersion || 1) + 1 }); await sessions.get(u.id).stop('Account disabled by admin'); return res.json({ ok: true }); }
  if (a === 'enable') { db.updateUser(u.id, { disabled: false }); if (sessions.hasAuth(u.id)) sessions.get(u.id).start().catch(() => {}); return res.json({ ok: true }); }
  if (a === 'reset-password') {
    const temp = crypto.randomBytes(6).toString('base64url');
    db.updateUser(u.id, { passHash: await auth.hashPassword(temp), tokenVersion: (u.tokenVersion || 1) + 1 });
    return res.json({ ok: true, tempPassword: temp });
  }
  if (a === 'delete') { await sessions.remove(u.id); db.deleteUser(u.id); ud.removeUserData(u.id); return res.json({ ok: true }); }
  res.status(400).json({ error: 'Unknown action.' });
}));
adm.get('/extras', (req, res) => res.json({ settings: adminSettings.get(), backups: backup.list(), last: backup.last() }));
adm.post('/settings', (req, res) => res.json({ settings: adminSettings.set(req.body || {}) }));
adm.post('/backup', wrap(async (req, res) => {
  const r = await backup.run('manual');
  if (!r.ok) return res.status(500).json({ error: `Backup failed: ${r.error}` });
  res.json(r.sentToWhatsApp === false ? { ...r, warning: `Saved, but not sent to WhatsApp: ${r.sendError}` } : r);
}));
adm.get('/backup/:name', (req, res) => {
  const f = backup.pathOf(req.params.name);
  if (!f) return res.status(404).json({ error: 'No such backup.' });
  res.download(f, req.params.name);
});
app.use('/api/admin', adm);

app.use((req, res) => res.status(404).send(pages.landing(req.user)));

// ---------- first admin ----------
function ensureAdminInvite() {
  if (db.hasAdmin()) return;
  let inv = db.listInvites().find((i) => i.admin && i.usesLeft > 0);
  if (!inv) inv = db.createInvite({ note: 'first admin', admin: true });
  const f = path.join(cfg.DATA_DIR, 'ADMIN_INVITE.txt');
  fs.writeFileSync(f, inv.code + '\n', { mode: 0o600 });
  console.log(`\n=== No admin yet. Sign up at /signup with invite code: ${inv.code} (also saved in ${f}) ===\n`);
}

// ---------- start ----------
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const s of sessions.all().values()) { try { s.saveTextCache(); } catch {} } ud.flushLogs(); process.exit(0); });

ensureAdminInvite();
app.listen(cfg.PORT, '0.0.0.0', () => {
  console.log(`${cfg.APP_NAME} web on port ${cfg.PORT}`);
  if (!process.env.NO_WHATSAPP) sessions.startAll();
  backup.schedule();
});
