// WhatsApp alerts, sent from the admin's own linked WhatsApp.
// - To the admin ("Message yourself" chat): a user's link was logged out, stayed offline,
//   or is hitting lots of errors; backup files if that option is on.
// - To the affected user (their own number): "your link dropped, open the dashboard to relink".
// Each alert type is sent at most once every 6 hours per user, so nobody gets spammed.
const db = require('./db');
const ud = require('./userdata');
const adminSettings = require('./adminsettings');

const THROTTLE_MS = 6 * 3600e3;
const sent = new Map(); // `${uid}:${kind}` -> time

function adminSessions() {
  const sessions = require('./sessions');
  return db.listUsers().filter((u) => u.isAdmin && !u.disabled)
    .map((u) => sessions.all().get(u.id))
    .filter((s) => s && s.state === 'connected' && s.sock && s.me);
}

function throttled(uid, kind) {
  const k = `${uid}:${kind}`;
  const t = sent.get(k);
  if (t && Date.now() - t < THROTTLE_MS) return true;
  sent.set(k, Date.now());
  return false;
}

async function toAdmins(text) {
  for (const s of adminSessions()) {
    try { await s.sock.sendMessage(s.meLid || s.me, { text }); } catch (e) { console.error('[alerts] admin send failed:', e.message); }
  }
}

async function toUser(user, text) {
  if (!user?.phone || !adminSettings.get().alertUsers) return;
  const admins = adminSessions();
  if (!admins.length) return;
  const jid = `${user.phone}@s.whatsapp.net`;
  if (admins.some((s) => s.me === jid)) return; // the admin themself already gets the admin alert
  try { await admins[0].sock.sendMessage(jid, { text }); } catch (e) { console.error('[alerts] user send failed:', e.message); }
}

/**
 * Called by sessions.js when something worth telling people happens.
 * kind: 'logged_out' | 'offline' | 'replaced' | 'errors' | 'back_online'
 */
async function notify(uid, kind, detail = '') {
  if (!adminSettings.get().alerts) return;
  const user = db.getUser(uid);
  if (!user || user.disabled) return;
  if (kind === 'back_online') {
    // only worth saying if we previously alerted that it was offline
    if (!sent.has(`${uid}:offline`)) return;
    sent.delete(`${uid}:offline`);
    return toAdmins(`✅ ${user.email} is back online.`);
  }
  if (throttled(uid, kind)) return;
  const who = `${user.email}${user.phone ? ` (+${user.phone})` : ''}`;
  const msgs = {
    logged_out: [`⚠️ WhatsApp logged out ${who}. They need to link again from the dashboard.`,
      `⚠️ Your WA Recovery link was logged out by WhatsApp, so deleted messages aren't being saved. Open your dashboard and press "Get my link code" to reconnect.`],
    offline: [`⚠️ ${who} has been offline for over 10 minutes. ${detail}`.trim(),
      null],
    replaced: [`⚠️ ${who}: another copy of the bot connected with the same login, so this one stopped.`,
      null],
    errors: [`⚠️ ${who} hit ${detail} errors in the last 10 minutes. Check their activity log on the admin page.`,
      null],
  };
  const [adminText, userText] = msgs[kind] || [`⚠️ ${who}: ${kind} ${detail}`, null];
  ud.log(uid, 'warn', `Alert sent: ${kind}`);
  await toAdmins(adminText);
  if (userText) await toUser(user, userText);
}

async function sendBackupToAdmins(file, name) {
  const admins = adminSessions();
  if (!admins.length) throw new Error('no admin WhatsApp connected');
  for (const s of admins) {
    await s.sock.sendMessage(s.meLid || s.me, {
      document: { url: file }, fileName: name, mimetype: 'application/gzip',
      caption: `🗄️ Daily backup: ${name}\nContains everyone's WhatsApp logins. Don't forward it.`,
    });
  }
}

module.exports = { notify, sendBackupToAdmins, toAdmins };


/** Is this number on WhatsApp? null = can't tell right now (admin's WhatsApp offline). */
async function isOnWhatsApp(phone) {
  const s = adminSessions()[0]; if (!s) return null;
  try { const [r] = await s.sock.onWhatsApp(`${phone}@s.whatsapp.net`); return !!r?.exists; } catch { return null; }
}
/** Send a message to any number from the admin's WhatsApp. Throws if it can't. */
async function sendToNumber(phone, text) {
  const s = adminSessions()[0];
  if (!s) throw new Error("the admin's WhatsApp isn't connected");
  await s.sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
}
module.exports.toAdmins = toAdmins;
module.exports.isOnWhatsApp = isOnWhatsApp;
module.exports.sendToNumber = sendToNumber;
