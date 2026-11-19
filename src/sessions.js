// One WhatsApp connection per user, plus all the recovery logic.
//
// Each user gets their own Baileys socket, auth folder, message cache and saved media.
// A crash or disconnect in one user's session never affects the others.
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore,
  Browsers, jidNormalizedUser, fetchLatestBaileysVersion, BufferJSON,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { MSG_CACHE_PER_USER, DATA_DIR } = require('./config');
const ud = require('./userdata');
const media = require('./media');
const db = require('./db');
const alerts = require('./alerts');

const silent = pino({ level: 'silent' });
const sessions = new Map(); // uid -> Session

let waVersion = null;
async function getVersion() {
  if (waVersion) return waVersion;
  try { waVersion = (await fetchLatestBaileysVersion()).version; } catch { waVersion = undefined; }
  return waVersion;
}

// ---------- helpers ----------
function extractText(m) {
  if (!m) return null;
  m = media.unwrap(m) || m;
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
    m.videoMessage?.caption || m.documentMessage?.caption || null;
}
const CMD_RE = /^\.(vvc?|ping|help|ad|tag(all)?|menu|block|unblock|transcribe|tr|admins)(\s|$)/i;
const isCommandText = (t) => !!t && CMD_RE.test(String(t).trim());
const TEXT_CACHE_MAX = 3000, TEXT_CACHE_DAYS = 3;
function typeOf(m) {
  const part = media.mediaPart(m);
  return part ? part.type : 'text';
}
function isViewOnce(m) {
  if (!m) return false;
  if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) return true;
  return !!(m.imageMessage?.viewOnce || m.videoMessage?.viewOnce || m.audioMessage?.viewOnce);
}
const num = (jid) => String(jid || '').split('@')[0].split(':')[0];
const tsMs = (msg) => Number(msg.messageTimestamp?.toNumber?.() ?? msg.messageTimestamp ?? 0) * 1000;

// ---------- durations for .block ----------
const UNITS = { m: 60e3, min: 60e3, mins: 60e3, h: 3600e3, hr: 3600e3, hrs: 3600e3, d: 864e5, day: 864e5, days: 864e5, w: 6048e5, wk: 6048e5 };
/** "30m" / "2h" / "1d" / "1w" -> milliseconds, or null if it isn't a duration. Max 1 year. */
function parseDuration(t) {
  const m = /^(\d{1,4})(m|min|mins|h|hr|hrs|d|day|days|w|wk)$/i.exec(String(t || '').trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNITS[m[2].toLowerCase()];
  return ms > 0 && ms <= 366 * 864e5 ? ms : null;
}
/** 5400000 -> "1h 30m" */
function left(ms) {
  const total = Math.max(1, Math.ceil(Math.max(0, ms) / 60e3)); // whole minutes, rounded up
  const d = Math.floor(total / 1440), h = Math.floor(total / 60) % 24, m = total % 60;
  return [d && d + 'd', h && h + 'h', m && m + 'm'].filter(Boolean).join(' ');
}
const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: process.env.TZ_DISPLAY || 'Africa/Lagos', weekday: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- Gemini (voice-note transcription) ----------
// The key comes from the GEMINI_API_KEY environment variable, or from data/gemini.key on the server.
// It is never stored in the code or the repo.
function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try { return fs.readFileSync(require('path').join(DATA_DIR, 'gemini.key'), 'utf8').trim() || null; } catch { return null; }
}
async function geminiTranscribe(key, buf, mime) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(90e3),
    body: JSON.stringify({
      contents: [{ parts: [
        { text: 'Transcribe this voice note word for word, in the language it is spoken in. ' +
                'If it is not in English, add an English translation after a line that says "English:". ' +
                'Reply with only the transcript.' },
        { inline_data: { mime_type: mime, data: buf.toString('base64') } },
      ] }],
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Gemini error ${res.status}`);
  return (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim();
}

class Session {
  constructor(uid) {
    this.uid = uid;
    this.sock = null;
    this.state = 'stopped';  // stopped | starting | waiting_link | connected | reconnecting | logged_out | error
    this.qr = null;          // data-URL image of the current QR code
    this.pairingCode = null;
    this.pairPhone = null;
    this.me = null; this.meLid = null;
    this.lastConnected = null;
    this.retries = 0;
    this.timer = null;
    this.cache = new Map();  // msgId -> cached message
    this.loadTextCache();
    this.handled = new Set(); // ids already recovered (avoid double sends)
    this.sent = new Map();    // messages the bot sent, kept so WhatsApp can ask for a re-send
    this.retryCounts = new Map();
    this.groupNames = new Map();
    this.names = new Map();   // jid -> last seen display name
    this.contacts = this.loadJson('contacts.json'); // names YOU saved in your phone, synced from WhatsApp
    this.lidMap = this.loadLidMap(); // WhatsApp hides numbers behind "LID" ids; this maps them back to phone numbers
    this.stats = ud.loadStats(uid); // all-time counts, kept in stats.json so they survive restarts
    this.viewOnces = this.loadViewOnces(); // latest view-once per person, for ".vv <number>" 
  }

  /** Text messages survive restarts, so an edit/delete right after a restart can still be recovered. */
  loadTextCache() {
    try {
      const rows = JSON.parse(fs.readFileSync(require('path').join(ud.userDir(this.uid), 'textcache.json'), 'utf8'));
      const cutoff = Date.now() - TEXT_CACHE_DAYS * 864e5;
      for (const [id, r] of rows) if (r.t > cutoff) this.cache.set(id, { message: { conversation: r.text }, chatId: r.chatId, sender: r.sender, senderPn: r.senderPn, pushName: r.pushName, t: r.t, file: null });
    } catch {}
  }
  saveTextCacheSoon() {
    if (this.textSave) return;
    this.textSave = setTimeout(() => { this.textSave = null; this.saveTextCache(); }, 20e3);
  }
  saveTextCache() {
    try {
      const rows = [];
      for (const [id, e] of this.cache) {
        if (media.mediaPart(e.message)) continue;
        const text = extractText(e.message); if (!text) continue;
        rows.push([id, { text, chatId: e.chatId, sender: e.sender, senderPn: e.senderPn, pushName: e.pushName, t: e.t }]);
      }
      const p = require('path').join(ud.userDir(this.uid), 'textcache.json');
      fs.writeFileSync(p + '.tmp', JSON.stringify(rows.slice(-TEXT_CACHE_MAX))); fs.renameSync(p + '.tmp', p);
    } catch {}
  }

  // ---------- latest view-once per person (for ".vv <number>") ----------
  // Kept in vonce.json (with the media download keys) so it survives restarts. 14 days, 300 people max.
  loadViewOnces() {
    try {
      const rows = JSON.parse(fs.readFileSync(require('path').join(ud.userDir(this.uid), 'vonce.json'), 'utf8'), BufferJSON.reviver);
      const cutoff = Date.now() - 14 * 864e5;
      return new Map(rows.filter(([, v]) => v.t > cutoff));
    } catch { return new Map(); }
  }
  noteViewOnce(id, entry) {
    const who = entry.senderPn || this.toPn(entry.sender) || jidNormalizedUser(entry.sender);
    this.viewOnces.delete(who); // re-insert so the newest is last
    this.viewOnces.set(who, { id, chatId: entry.chatId, sender: entry.sender, senderPn: entry.senderPn, pushName: entry.pushName, t: entry.t, message: entry.message, file: null });
    while (this.viewOnces.size > 300) this.viewOnces.delete(this.viewOnces.keys().next().value);
    clearTimeout(this.voSave);
    this.voSave = setTimeout(() => {
      try {
        const p = require('path').join(ud.userDir(this.uid), 'vonce.json');
        fs.writeFileSync(p + '.tmp', JSON.stringify([...this.viewOnces], BufferJSON.replacer)); fs.renameSync(p + '.tmp', p);
      } catch (e) { this.log('warn', `Couldn't save the view-once list: ${e.message}`); }
    }, 3000);
    this.voSave.unref?.();
  }
  /** The latest view-once from a phone number (also matches people WhatsApp shows by hidden ID). */
  latestViewOnce(pnJid) {
    let best = this.viewOnces.get(pnJid) || null;
    for (const [k, v] of this.viewOnces) {
      if (k !== pnJid && (this.toPn(k) === pnJid || this.toPn(v.sender) === pnJid) && (!best || v.t > best.t)) best = v;
    }
    return best;
  }

  /** Add to a recovery count and save it to disk shortly after. */
  bump(k, n = 1) {
    this.stats[k] = (this.stats[k] || 0) + n;
    if (this.statsSave) return;
    this.statsSave = setTimeout(() => { this.statsSave = null; ud.saveStats(this.uid, this.stats); }, 5000);
    this.statsSave.unref?.();
  }
  flushStats() { clearTimeout(this.statsSave); this.statsSave = null; ud.saveStats(this.uid, this.stats); }

  loadJson(f) {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(require('path').join(ud.userDir(this.uid), f), 'utf8')))); }
    catch { return new Map(); }
  }
  saveContactsSoon() {
    clearTimeout(this.contactSave);
    this.contactSave = setTimeout(() => {
      try { fs.writeFileSync(require('path').join(ud.userDir(this.uid), 'contacts.json'), JSON.stringify(Object.fromEntries(this.contacts))); } catch {}
    }, 3000);
  }
  /** Store saved contact names (from your phone's address book) and WhatsApp profile names. */
  learnContacts(list) {
    let changed = false;
    for (const c of list || []) {
      if (!c?.id) continue;
      if (c.lid && (c.jid || c.id.endsWith('@s.whatsapp.net'))) this.learnLid(c.lid, c.jid || c.id);
      if (c.id.endsWith('@lid') && c.jid) this.learnLid(c.id, c.jid);
      const ids = [c.id, c.jid, c.lid].filter(Boolean).map((j) => jidNormalizedUser(j));
      for (const j of ids) {
        const cur = this.contacts.get(j) || {};
        const next = { ...cur };
        if (c.name) next.name = c.name;            // saved in your contacts
        if (c.notify) next.notify = c.notify;      // their WhatsApp profile name
        if (next.name !== cur.name || next.notify !== cur.notify) { this.contacts.set(j, next); changed = true; }
      }
    }
    if (changed) this.saveContactsSoon();
  }
  loadLidMap() {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(require('path').join(ud.userDir(this.uid), 'lidmap.json'), 'utf8')))); }
    catch { return new Map(); }
  }
  learnLid(lid, pn) {
    if (!lid || !pn || !lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
    const l = jidNormalizedUser(lid), p = jidNormalizedUser(pn);
    if (this.lidMap.get(l) === p) return;
    this.lidMap.set(l, p);
    clearTimeout(this.lidSave);
    this.lidSave = setTimeout(() => {
      try { fs.writeFileSync(require('path').join(ud.userDir(this.uid), 'lidmap.json'), JSON.stringify(Object.fromEntries(this.lidMap))); } catch {}
    }, 3000);
  }
  /** Turn any jid (phone or LID) into a phone-number jid when we know it. */
  toPn(jid) {
    if (!jid) return null;
    const j = jidNormalizedUser(jid);
    if (j.endsWith('@lid')) return this.lidMap.get(j) || null;
    return j;
  }
  /** "Tolu (+2348012345678)", or "Tolu" if WhatsApp hid the number and we haven't learned it yet. */
  person(jid, name) {
    const pn = this.toPn(jid);
    const j = jid ? jidNormalizedUser(jid) : '';
    // 1) the name YOU saved for them, 2) the name they set on WhatsApp (shown with ~, like WhatsApp does)
    const saved = (pn && this.contacts.get(pn)?.name) || this.contacts.get(j)?.name;
    const profile = name || this.names.get(j) || (pn && this.names.get(pn)) || (pn && this.contacts.get(pn)?.notify) || this.contacts.get(j)?.notify;
    const nm = saved || (profile ? `~${profile}` : '');
    if (pn) return nm ? `${nm} (+${num(pn)})` : `+${num(pn)}`;
    return nm ? `${nm} (number hidden by WhatsApp)` : 'Someone (number hidden by WhatsApp)';
  }
  /** Learn phone numbers + names from every message key WhatsApp sends us. */
  learnFromKey(key, pushName) {
    if (!key) return;
    this.learnLid(key.remoteJid, key.senderPn);
    this.learnLid(key.senderLid, key.senderPn || (key.remoteJid?.endsWith('@s.whatsapp.net') ? key.remoteJid : null));
    this.learnLid(key.participant, key.participantPn);
    this.learnLid(key.participantLid, key.participantPn || (key.participant?.endsWith('@s.whatsapp.net') ? key.participant : null));
    // Baileys 7: the "other" address (phone number <-> hidden ID) comes as remoteJidAlt / participantAlt
    this.learnLid(key.remoteJid, key.remoteJidAlt); this.learnLid(key.remoteJidAlt, key.remoteJid);
    this.learnLid(key.participant, key.participantAlt); this.learnLid(key.participantAlt, key.participant);
    if (pushName && !key.fromMe) {
      const who = key.participant || key.remoteJid;
      if (who) { this.names.set(jidNormalizedUser(who), pushName); const pn = this.toPn(who); if (pn) this.names.set(pn, pushName); }
    }
  }

  log(level, msg) {
    ud.log(this.uid, level, msg);
    if (level !== 'error') return;
    this.bump('errors');
    const now = Date.now();
    this.recentErrors = (this.recentErrors || []).filter((t) => now - t < 10 * 60e3);
    this.recentErrors.push(now);
    if (this.recentErrors.length >= 5) alerts.notify(this.uid, 'errors', this.recentErrors.length).catch(() => {});
  }
  /** Start a 10-minute timer when the link drops; alert if it hasn't come back by then. */
  watchOffline() {
    if (this.offlineTimer) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.state !== 'connected' && this.state !== 'stopped' && this.state !== 'logged_out') {
        alerts.notify(this.uid, 'offline', `Last state: ${this.state}.`).catch(() => {});
      }
    }, 10 * 60e3);
    this.offlineTimer.unref?.();
  }
  clearOffline() { clearTimeout(this.offlineTimer); this.offlineTimer = null; }

  status() {
    return {
      state: this.state, qr: this.qr, pairingCode: this.pairingCode, me: this.me ? num(this.me) : null,
      lastConnected: this.lastConnected, stats: this.stats, cached: this.cache.size,
    };
  }

  // ---------- connection lifecycle ----------
  async start({ phone = null } = {}) {
    clearTimeout(this.timer);
    if (phone) this.pairPhone = String(phone).replace(/\D/g, '');
    this.closeSocket();
    this.state = this.state === 'connected' ? 'reconnecting' : 'starting';
    this.qr = null; this.pairingCode = null;

    const { state, saveCreds } = await useMultiFileAuthState(ud.authDir(this.uid));
    const sock = makeWASocket({
      version: await getVersion(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silent) },
      logger: silent,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // When a phone can't decrypt something (shows "Waiting for this message"), it asks for a re-send.
      // Baileys can only re-send if we hand the message back here, so we keep everything we send.
      getMessage: async (key) => this.sent.get(key.id) || this.cache.get(key.id)?.message,
      msgRetryCounterCache: {
        get: (k) => this.retryCounts.get(k), set: (k, v) => { this.retryCounts.set(k, v); if (this.retryCounts.size > 2000) this.retryCounts.clear(); },
        del: (k) => this.retryCounts.delete(k), flushAll: () => this.retryCounts.clear(),
      },
    });
    this.sock = sock;
    // remember every message we send (last 500) so failed ones can be re-sent on request
    const rawSend = sock.sendMessage.bind(sock);
    sock.sendMessage = async (...args) => {
      let r;
      try { r = await rawSend(...args); } catch (e) {
        // if sending to your hidden ID (LID) fails, fall back to your phone number
        if (this.meLid && args[0] === this.meLid && this.me) { this.log('warn', `Send to your own chat via ID failed (${e.message}); used your number instead.`); r = await rawSend(this.me, ...args.slice(1)); } else throw e;
      }
      if (r?.key?.id && r.message) {
        this.sent.set(r.key.id, r.message);
        if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value);
      }
      return r;
    };
    sock.ev.on('messages.update', (ups) => {
      for (const u of ups) if (u.key?.fromMe && u.update?.status === 0 && this.sent.has(u.key.id)) this.log('warn', 'WhatsApp reported a message the bot sent as failed; it will be re-sent if your phone asks.');
    });
    const mine = () => this.sock === sock; // ignore events from a socket we've replaced

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (!mine()) return;
      const { connection, qr, lastDisconnect } = u;
      if (qr) {
        this.state = 'waiting_link';
        if (this.pairPhone && !state.creds.registered && !this.pairingCode) {
          try {
            const code = await sock.requestPairingCode(this.pairPhone);
            this.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
            this.log('info', `Pairing code created for +${this.pairPhone}`);
          } catch (e) {
            this.log('error', `Could not get a pairing code: ${e.message}. Use the QR code instead.`);
          }
        }
        try { this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); } catch {}
      }
      if (connection === 'open') {
        this.state = 'connected'; this.retries = 0; this.qr = null; this.pairingCode = null; this.pairPhone = null;
        this.me = jidNormalizedUser(sock.user.id);
        this.meLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;
        this.lastConnected = Date.now();
        db.updateUser(this.uid, { phone: num(this.me) });
        this.log('info', `Connected as +${num(this.me)}`);
        this.clearOffline();
        this.startBlockTimer();
        alerts.notify(this.uid, 'back_online').catch(() => {});
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'unknown';
        if (code === DisconnectReason.loggedOut) {
          this.state = 'logged_out'; this.qr = null; this.closeSocket();
          ud.removeAuth(this.uid);
          this.log('warn', 'WhatsApp logged this device out. Link again from the dashboard.');
          this.clearOffline();
          alerts.notify(this.uid, 'logged_out').catch(() => {});
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          this.log('warn', 'Another copy of this bot connected with the same login. Stopped this one to avoid a fight.');
          this.state = 'error'; this.closeSocket();
          alerts.notify(this.uid, 'replaced').catch(() => {});
          return;
        }
        if (!state.creds.registered && this.retries >= 4) {
          const wasWaiting = this.state === 'waiting_link';
          this.state = 'stopped'; this.qr = null; this.pairingCode = null; this.closeSocket();
          this.log(wasWaiting ? 'info' : 'error', wasWaiting
            ? 'Link code expired. Press "Link WhatsApp" again when ready.'
            : `Couldn't reach WhatsApp to start linking (${code || reason}). Try again in a minute.`);
          return;
        }
        this.state = 'reconnecting';
        if (state.creds.registered) this.watchOffline();
        const wait = code === DisconnectReason.restartRequired ? 500 : Math.min(60e3, 2000 * 2 ** this.retries);
        this.retries++;
        if (code !== DisconnectReason.restartRequired) this.log('warn', `Connection dropped (${code || reason}). Retrying in ${Math.round(wait / 1000)}s.`);
        this.timer = setTimeout(() => this.start().catch((e) => this.log('error', `Restart failed: ${e.message}`)), wait);
      }
    });

    sock.ev.on('contacts.upsert', (list) => { if (mine()) this.learnContacts(list); });
    sock.ev.on('contacts.update', (list) => { if (mine()) this.learnContacts(list); });
    sock.ev.on('messaging-history.set', ({ contacts }) => { if (mine()) this.learnContacts(contacts); });

    sock.ev.on('messages.upsert', ({ messages }) => {
      if (!mine()) return;
      for (const msg of messages) this.onMessage(msg).catch((e) => this.log('error', `Message handling failed: ${e.message}`));
    });

    sock.ev.on('messages.update', (updates) => {
      if (!mine()) return;
      for (const u of updates) this.onUpdate(u).catch((e) => this.log('error', `Update handling failed: ${e.message}`));
    });
  }

  closeSocket() {
    const s = this.sock; this.sock = null;
    if (s) { try { s.ev.removeAllListeners(); } catch {} try { s.end(undefined); } catch {} }
  }

  async stop(reason = 'Stopped') {
    clearTimeout(this.timer); this.clearOffline();
    clearTimeout(this.textSave); this.textSave = null; this.saveTextCache(); this.flushStats(); clearInterval(this.blockTimer);
    this.closeSocket();
    this.state = 'stopped'; this.qr = null; this.pairingCode = null;
    this.log('info', reason);
  }

  /**
   * Fix "Waiting for this message" in your own chat: throw away the bot's encryption sessions
   * with YOUR phone (not other people's) so fresh ones are made on the next message. No relink needed.
   */
  async resetSelfSessions() {
    if (!this.me) throw new Error('Link WhatsApp first.');
    const dir = ud.authDir(this.uid);
    const ids = [num(this.me), this.meLid ? num(this.meLid) : null].filter(Boolean);
    let removed = 0;
    for (const f of fs.readdirSync(dir)) {
      if (ids.some((id) => f.startsWith(`session-${id}.`) || f.startsWith(`session-${id}_`))) {
        fs.unlinkSync(require('path').join(dir, f)); removed++;
      }
    }
    this.log('info', `Reset ${removed} encryption session(s) with your own phone. Restarting the connection.`);
    await this.start();
    return removed;
  }

  async unlink() {
    clearTimeout(this.timer); this.clearOffline();
    try { await this.sock?.logout(); } catch {}
    this.closeSocket();
    ud.removeAuth(this.uid);
    this.state = 'stopped'; this.qr = null; this.pairingCode = null; this.me = null;
    this.log('info', 'WhatsApp unlinked.');
  }

  // Your own chat is addressed by your LID (hidden ID) on newer WhatsApp. Sending there keeps the
  // bot on the same encryption link your phone uses; sending to the phone number caused "Waiting for this message".
  selfJid() { return this.meLid || this.me; }

  isSelf(jid) { return !!jid && (jid === this.me || jid === this.meLid); }

  // ---------- incoming messages ----------
  async onMessage(msg) {
    if (!msg.key?.id) return;
    // WhatsApp never gives linked devices the view-once itself: only an empty "view-once" notice.
    // Note who sent it and where, so ".vv <number>" can point you to it (reply .vv to it on your phone).
    if (!msg.message && msg.key.isViewOnce && !msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
      this.learnFromKey(msg.key, msg.pushName);
      const chatId = msg.key.remoteJid, sender = msg.key.participant || chatId;
      const alt = [msg.key.participantPn, msg.key.senderPn, msg.key.participantAlt, msg.key.remoteJidAlt].find((j) => j && j.endsWith('@s.whatsapp.net'));
      this.noteViewOnce(msg.key.id, { message: {}, chatId, sender, senderPn: !sender.endsWith('@g.us') && alt ? alt : undefined, pushName: msg.pushName, t: tsMs(msg) || Date.now() });
      return;
    }
    if (!msg.message) {
      if (msg.messageStubType === 2) { // CIPHERTEXT = WhatsApp sent it but we couldn't decrypt it
        const who = msg.key.fromMe ? 'your own phone' : this.person(msg.key.participant || msg.key.remoteJid);
        this.log('warn', `Could not decrypt a message from ${who} (${msg.messageStubParameters?.[0] || 'no detail'}).`);
        // only reset after repeated failures (3 within 2 min), never more than once per 10 min
        if (msg.key.fromMe) this.selfFails = (this.selfFails || []).filter((t) => Date.now() - t < 120e3).concat(Date.now());
        if (msg.key.fromMe && this.selfFails.length >= 3 && Date.now() - (this.lastSelfReset || 0) > 10 * 60e3) {
          this.selfFails = [];
          this.lastSelfReset = Date.now();
          this.log('info', 'Auto-fixing the encryption link with your phone.');
          setTimeout(() => this.resetSelfSessions().catch((e) => this.log('error', `Auto-fix failed: ${e.message}`)), 3000);
        }
      }
      return;
    }
    this.learnFromKey(msg.key, msg.pushName);
    const chatId = msg.key.remoteJid;
    const m = msg.message;
    const isStatus = chatId === 'status@broadcast';

    // 1) your own commands (.vv, .vvc, .ping, .help, .ad ...) — only fresh ones, never old history
    if (msg.key.fromMe && Date.now() - tsMs(msg) < 3 * 60e3) {
      const text = (m.conversation || m.extendedTextMessage?.text || '').trim();
      if (text.startsWith('.')) { if (await this.onCommand(msg, chatId, text)) return; }
    }

    // 2) edits and deletes arrive as protocol messages
    if (m.protocolMessage) return this.onProtocol(msg, chatId, m.protocolMessage);
    if (m.editedMessage?.message?.protocolMessage) return this.onProtocol(msg, chatId, m.editedMessage.message.protocolMessage);

    if (msg.key.fromMe) return; // don't cache or recover your own messages

    // every view-once is noted (whatever your recovery settings), so ".vv <number>" can fetch it later
    if (isViewOnce(m) && !isStatus) {
      const alt = [msg.key.participantPn, msg.key.senderPn, msg.key.participantAlt, msg.key.remoteJidAlt].find((j) => j && j.endsWith('@s.whatsapp.net'));
      const sender = msg.key.participant || chatId;
      this.noteViewOnce(msg.key.id, { message: m, chatId, sender, senderPn: !sender.endsWith('@g.us') && alt ? alt : undefined, pushName: msg.pushName, t: tsMs(msg) || Date.now() });
    }
    const cfg = ud.effective(this.uid, chatId);
    if (!cfg.enabled || (isStatus && !cfg.statusDeleted && !cfg.statusEdited)) return;

    // 3) remember the message so a later delete/edit can be recovered
    //    (skip other people's bot commands like .vv — their bot deletes those on purpose)
    if (!media.mediaPart(m) && isCommandText(extractText(m))) return;
    const entry = { message: m, chatId, sender: msg.key.participant || chatId, pushName: msg.pushName, t: Date.now(), file: null };
    { const alt = [msg.key.participantPn, msg.key.senderPn, msg.key.participantAlt, msg.key.remoteJidAlt].find((j) => j && j.endsWith('@s.whatsapp.net'));
      if (!entry.sender.endsWith('@g.us') && alt) entry.senderPn = alt; }
    this.remember(msg.key.id, entry);

    // 4) view-once: try to save it straight away
    if (isViewOnce(m) && cfg.viewOnce) {
      const part = media.mediaPart(m);
      if (!part) { this.log('info', `View-once from ${this.who(entry)} arrived without the media (WhatsApp hides it from linked devices). Reply .vv to it.`); return; }
      try {
        const file = await media.saveAhead(this.uid, msg, this.sock);
        if (file) {
          entry.file = file;
          const vo = this.viewOnces.get(entry.senderPn || this.toPn(entry.sender) || jidNormalizedUser(entry.sender)); if (vo?.id === msg.key.id) vo.file = file;
          await this.sendFile(this.selfJid(), part, file, `👁️ *View-once ${part.type}*\nFrom: ${this.who(entry)}\nChat: ${await this.chatLabel(chatId)}`);
          this.bump('viewOnce');
          this.log('info', `Saved a view-once ${part.type} from ${this.who(entry)}`);
        }
      } catch (e) { this.log('warn', `View-once from ${this.who(entry)} could not be downloaded (${e.message}). Reply .vv to it.`); }
      return;
    }

    // 5) download other media ahead of time so it survives deletion
    const part = media.mediaPart(m);
    if (part && cfg.saveMediaAhead && cfg[part.type] !== false) {
      media.saveAhead(this.uid, msg, this.sock)
        .then((f) => { entry.file = f; })
        .catch((e) => this.log('warn', `Couldn't pre-save a ${part.type} from ${this.who(entry)}: ${e.message}`));
    }
  }

  remember(id, entry) {
    this.cache.set(id, entry);
    if (!media.mediaPart(entry.message)) this.saveTextCacheSoon();
    if (this.cache.size > MSG_CACHE_PER_USER) this.cache.delete(this.cache.keys().next().value);
    if (this.handled.size > 5000) this.handled.clear();
  }

  async onProtocol(msg, chatId, p) {
    const targetId = p.key?.id;
    if (!targetId) return;
    if (msg.key.fromMe) return; // you deleted/edited your own message
    if (p.editedMessage || p.type === 14) return this.recoverEdit(chatId, targetId, p.editedMessage, { sender: msg.key.participant || chatId, pushName: msg.pushName, alt: [msg.key.participantPn, msg.key.senderPn, msg.key.participantAlt, msg.key.remoteJidAlt].find((j) => j && j.endsWith('@s.whatsapp.net')) });
    if (p.type === 0 || p.type === undefined || p.type === null) return this.recoverDelete(chatId, targetId);
  }

  async onUpdate({ key, update }) {
    this.learnFromKey(key);
    if (!key?.id || key.fromMe) return;
    const edited = update?.message?.editedMessage?.message?.protocolMessage?.editedMessage ||
      update?.message?.protocolMessage?.editedMessage || update?.message?.editedMessage?.message;
    if (edited) return this.recoverEdit(key.remoteJid, key.id, edited, { sender: key.participant || key.remoteJid });
    if (update?.message === null || update?.messageStubType === 1 || update?.messageStubType === 68) {
      return this.recoverDelete(key.remoteJid, key.id);
    }
  }

  who(entry) { return this.person(entry.senderPn || entry.sender, entry.pushName); }

  async chatLabel(chatId) {
    if (chatId === 'status@broadcast') return 'Status';
    if (!chatId?.endsWith('@g.us')) return 'Private chat';
    if (!this.groupNames.has(chatId)) {
      try { this.groupNames.set(chatId, (await this.sock.groupMetadata(chatId)).subject); }
      catch { this.groupNames.set(chatId, 'a group'); }
    }
    return `${this.groupNames.get(chatId)} (group)`;
  }

  async recoverDelete(chatId, id) {
    const key = 'del:' + id;
    if (this.handled.has(key)) return;
    const entry = this.cache.get(id);
    if (!entry) { this.log('info', `A message was deleted in ${await this.chatLabel(chatId)}, but it arrived before the bot saw it.`); return; }
    const cfg = ud.effective(this.uid, entry.chatId);
    const type = typeOf(entry.message);
    if (!cfg.enabled || cfg[type] === false) return;
    if (entry.chatId === 'status@broadcast' && !cfg.statusDeleted) return;
    if (type === 'text' && isCommandText(extractText(entry.message))) return;
    this.handled.add(key);
    const header = `🗑️ *Deleted ${entry.chatId === 'status@broadcast' ? 'status' : type === 'text' ? 'message' : type}*\nFrom: ${this.who(entry)}\nChat: ${await this.chatLabel(entry.chatId)}`;
    try {
      const part = media.mediaPart(entry.message);
      if (!part) {
        await this.sock.sendMessage(this.selfJid(), { text: `${header}\n\n${extractText(entry.message) || '[message]'}` });
      } else {
        let file = entry.file && fs.existsSync(entry.file) ? entry.file : null;
        if (!file) file = await media.saveAhead(this.uid, { key: { id }, message: entry.message }, this.sock);
        if (!file) throw new Error('file too large or unavailable');
        await this.sendFile(this.selfJid(), part, file, header + (part.node.caption ? `\n\n${part.node.caption}` : ''));
      }
      this.bump('deleted');
      this.log('info', `Recovered a deleted ${type} from ${this.who(entry)}`);
    } catch (e) {
      this.log('error', `Couldn't recover a deleted ${type} from ${this.who(entry)}: ${e.message}`);
      try { await this.sock.sendMessage(this.selfJid(), { text: `${header}\n\n[Couldn't recover the ${type}: ${e.message}]` }); } catch {}
    }
  }

  async recoverEdit(chatId, id, newMsg, meta = {}) {
    const entry = this.cache.get(id);
    const cfg = ud.effective(this.uid, chatId);
    if (!cfg.enabled || !cfg.text) return;
    if (chatId === 'status@broadcast' && !cfg.statusEdited) return;
    const after = extractText(newMsg) || '[non-text]';
    const key = 'edit:' + id + ':' + after;
    if (this.handled.has(key)) return;
    this.handled.add(key);
    const before = entry ? (extractText(entry.message) || '[non-text]') : null;
    if (before !== null && before === after) return;
    const from = entry ? this.who(entry)
      : this.person(meta.alt || (meta.sender && !String(meta.sender).endsWith('@g.us') ? meta.sender : chatId), meta.pushName);
    const body = before !== null
      ? `*Before:* ${before}\n*After:* ${after}`
      : `*Now says:* ${after}\n_(The bot didn't see the original, so the old text isn't available.)_`;
    try {
      await this.sock.sendMessage(this.selfJid(), {
        text: `✏️ *Edited ${chatId === 'status@broadcast' ? 'status' : 'message'}*\nFrom: ${from}\nChat: ${await this.chatLabel(entry ? entry.chatId : chatId)}\n\n${body}`,
      });
      if (entry) entry.message = { conversation: after };
      else this.remember(id, { message: { conversation: after }, chatId, sender: meta.sender || chatId, senderPn: meta.alt, pushName: meta.pushName, t: Date.now(), file: null });
      this.bump('edited');
      this.log('info', `Recovered an edit from ${from}${before === null ? ' (original not seen)' : ''}`);
    } catch (e) { this.log('error', `Couldn't send an edit: ${e.message}`); }
  }

  async sendFile(to, part, file, caption, mentions) {
    const src = { url: file };
    const m = mentions?.length ? { mentions } : {};
    if (part.type === 'image') return this.sock.sendMessage(to, { image: src, caption, ...m });
    if (part.type === 'video') return this.sock.sendMessage(to, { video: src, caption, ...m });
    if (part.type === 'sticker') { await this.sock.sendMessage(to, { sticker: src }); return caption && this.sock.sendMessage(to, { text: caption, ...m }); }
    if (part.type === 'audio') {
      await this.sock.sendMessage(to, { audio: src, mimetype: part.node.mimetype || 'audio/ogg; codecs=opus', ptt: !!part.node.ptt });
      return caption && this.sock.sendMessage(to, { text: caption, ...m });
    }
    return this.sock.sendMessage(to, { document: src, mimetype: part.node.mimetype || 'application/octet-stream', fileName: part.node.fileName || 'file', caption, ...m });
  }

  /**
   * Caption for a view-once that .vv / .vvc sends.
   * inChat = true (.vvc): goes back into the chat, so the sender is @mentioned instead of showing their number.
   */
  async viewOnceCaption(part, { senderJid, cached, chatId, inChat }) {
    const kind = { image: 'photo', video: 'video', audio: 'voice note' }[part.type] || part.type;
    const lines = [`👁️ *View-once ${kind}*`];
    const mentions = [];
    if (inChat && senderJid && !this.isSelf(senderJid)) {
      const j = jidNormalizedUser(senderJid);
      lines.push(`From: @${j.split('@')[0]}`); mentions.push(j);
    } else {
      lines.push(`From: ${cached ? this.who(cached) : this.person(senderJid || chatId)}`);
    }
    if (!inChat) lines.push(`Chat: ${await this.chatLabel(chatId)}`);
    if (cached?.t) lines.push(`Sent: ${when(cached.t)}`);
    if (part.node.seconds && part.type !== 'image') lines.push(`Length: ${part.node.seconds}s`);
    if (part.node.caption) lines.push('', `💬 ${part.node.caption}`);
    return { caption: lines.join('\n'), mentions };
  }

  /** .vv <number>: send that person's latest view-once to your own chat. */
  async vvLatest(pnJid) {
    const toSelf = (t) => this.sock.sendMessage(this.selfJid(), { text: t });
    const vo = this.latestViewOnce(pnJid);
    const who = this.person(pnJid, vo?.pushName);
    if (!vo) return toSelf(`👁️ No view-once from ${who} in the last 14 days.\n\n_The bot only knows ones that arrived while it was connected._`);
    const ago = left(Date.now() - vo.t);
    const part = media.mediaPart(vo.message);
    if (!part) {
      return toSelf(`👁️ *${who}* sent you a view-once ${ago} ago\nChat: ${await this.chatLabel(vo.chatId)}\nSent: ${when(vo.t)}\n\nWhatsApp doesn't give view-once photos to linked devices, so the bot can't fetch it by number.\n👉 Open that chat on your phone and reply *.vv* to it (before opening it) - that works.`);
    }
    let file = vo.file && fs.existsSync(vo.file) ? vo.file : null;
    let temp = false;
    if (!file) {
      try { file = await media.downloadToFile(this.uid, part.node, part.key, vo.id, this.sock); temp = true; }
      catch (e) { return toSelf(`⚠️ Found ${who}'s view-once from ${ago} ago, but it couldn't be downloaded (${e.message}). It may have expired. Try replying *.vv* to it in the chat.`); }
    }
    try {
      const { caption } = await this.viewOnceCaption(part, { senderJid: vo.senderPn || vo.sender, cached: vo, chatId: vo.chatId, inChat: false });
      await this.sendFile(this.selfJid(), part, file, caption);
      this.bump('vv');
      this.log('info', `.vv ${num(pnJid)} sent their latest view-once ${part.type} to you`);
    } finally { if (temp) fs.unlink(file, () => {}); }
  }

  // ---------- .block / .unblock (real WhatsApp block, optionally for a set time) ----------
  async blockCommand(cmd, msg, chatId, args) {
    const sub = (args[0] || '').toLowerCase();
    if (cmd === '.block' && sub === 'list') {
      const list = Object.entries(ud.listBlocks(this.uid));
      if (!list.length) return '🚫 *Blocked by the bot*\n\nNobody right now.';
      return '🚫 *Blocked by the bot*\n\n' + list.map(([j, b]) => `• ${this.person(j, b.name)}\n   ${b.until ? '⏳ ' + left(b.until - Date.now()) + ' left' : '♾️ until you .unblock'}`).join('\n') +
        '\n\n_Unblock early with .unblock_';
    }
    // how long: last word like 30m, 2h, 1d, 1w (optional)
    let ms = null; const rest = [...args];
    if (rest.length && parseDuration(rest[rest.length - 1]) !== null) ms = parseDuration(rest.pop());
    else if (rest.length && /^\d+(m|min|mins|h|hr|hrs|d|day|days|w|wk)?$/i.test(rest[rest.length - 1]) && rest[rest.length - 1].replace(/\D/g, '').length < 6) {
      return '⚠️ I didn\'t understand that time. Use for example *30m*, *2h*, *1d* or *1w* (max 1 year).';
    }
    // who: a typed number, else the person you replied to, else the person in this private chat
    let target = null;
    const digits = rest.join('').replace(/\D/g, '');
    const ctx = msg.message.extendedTextMessage?.contextInfo;
    if (digits.length >= 8) target = `${digits}@s.whatsapp.net`;
    else if (ctx?.participant) target = ctx.participant;
    else if (!chatId.endsWith('@g.us') && chatId !== 'status@broadcast' && !this.isSelf(chatId)) target = chatId;
    if (!target) {
      return `⚠️ *${cmd}*: tell me who.\n\n• Reply to their message with *${cmd === '.block' ? '.block 2h' : cmd}*\n• Or send it in your chat with them\n• Or *${cmd} 2348012345678${cmd === '.block' ? ' 2h' : ''}*` +
        (cmd === '.block' ? '\n\n_Time is optional: 30m, 2h, 1d, 1w. Without it they stay blocked until .unblock._' : '');
    }
    const n = jidNormalizedUser(target);
    const jid = this.toPn(n) || n; // block by phone number when we know it
    if (this.isSelf(n) || this.isSelf(jid)) return '⚠️ You can\'t block yourself.';
    const label = this.person(jid);
    if (cmd === '.block') {
      await this.sock.updateBlockStatus(jid, 'block');
      const until = ms ? Date.now() + ms : null;
      ud.setBlock(this.uid, jid, { name: this.contacts.get(jid)?.name || this.names.get(jid) || this.names.get(n) || '', until });
      this.log('info', `Blocked ${label}${ms ? ' for ' + left(ms) : ''}`);
      return `🚫 *Blocked* ${label}\n\n` + (ms ? `⏳ For ${left(ms)}. I'll unblock them at ${when(until)} and tell you here.` : '♾️ Until you send *.unblock*.');
    }
    await this.sock.updateBlockStatus(jid, 'unblock');
    const had = ud.removeBlock(this.uid, jid) || ud.removeBlock(this.uid, n);
    this.log('info', `Unblocked ${label}`);
    return `✅ *Unblocked* ${label}` + (had ? '' : '\n_(They weren\'t on the bot\'s block list, but they\'re unblocked now.)_');
  }

  /** Every 30 s: unblock anyone whose time is up (also catches ones that expired while the bot was offline). */
  startBlockTimer() {
    clearInterval(this.blockTimer);
    const tick = async () => {
      if (this.state !== 'connected' || !this.sock) return;
      for (const [jid, b] of Object.entries(ud.listBlocks(this.uid))) {
        if (!b.until || b.until > Date.now()) continue;
        try {
          await this.sock.updateBlockStatus(jid, 'unblock');
          ud.removeBlock(this.uid, jid);
          const who = this.person(jid, b.name);
          this.log('info', `Time's up: unblocked ${who}`);
          await this.sock.sendMessage(this.selfJid(), { text: `⏰ *Time's up*\n\nUnblocked ${who}.` });
        } catch (e) { this.log('warn', `Couldn't unblock ${this.person(jid, b.name)} yet (${e.message}). Will retry.`); }
      }
    };
    this.blockTimer = setInterval(() => tick().catch(() => {}), 30e3);
    this.blockTimer.unref?.();
    setTimeout(() => tick().catch(() => {}), 5e3).unref?.();
  }

  // ---------- .admins: tag only the group's admins ----------
  // .admins <anything>  ->  posts your text in the group with every admin @tagged (like .tag, admins only).
  // Reply to a message with it to tag them on that message.
  async adminsCommand(msg, chatId, text) {
    if (!chatId.endsWith('@g.us')) return { self: '⚠️ *.admins* only works inside a group.' };
    this.adminsCooldown ||= new Map();
    const last = this.adminsCooldown.get(chatId) || 0;
    if (Date.now() - last < 60e3) return { self: '⏳ *.admins* was used in that group less than a minute ago. Try again shortly.' };
    const meta = await this.sock.groupMetadata(chatId);
    const mine = new Set([this.me, this.meLid].filter(Boolean).map((j) => num(j)));
    const admins = meta.participants.filter((p) => p.admin && !mine.has(num(p.id)) && !mine.has(num(p.phoneNumber))).map((p) => p.id);
    if (!admins.length) return { self: '⚠️ That group has no other admins to tag.' };
    this.adminsCooldown.set(chatId, Date.now());
    const note = text.replace(/^\.admins\b/i, '').trim();
    const tags = admins.map((j) => '@' + j.split('@')[0]).join(' ');
    const ctx = msg.message.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage ? { key: { remoteJid: chatId, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: ctx.quotedMessage } : undefined;
    return { group: { text: (note || '📢 Admins, please see this.') + '\n\n' + tags, mentions: admins }, quoted };
  }

  // ---------- .transcribe (Google Gemini, free tier) ----------
  async transcribeCommand(msg, chatId) {
    const ctx = msg.message.extendedTextMessage?.contextInfo;
    const part = ctx?.quotedMessage ? media.mediaPart(ctx.quotedMessage) : null;
    if (!part || !['audio', 'video'].includes(part.type)) return '📝 Reply to a voice note (or video) with *.transcribe* and its text comes here.';
    const key = geminiKey();
    if (!key) return '📝 *Transcription isn\'t switched on yet.*\nThe admin needs to add a free Gemini API key on the server.';
    if (Number(part.node.fileLength || 0) > 15 * 1048576) return '⚠️ That one is too long to transcribe (over 15 MB).';
    const file = await media.downloadToFile(this.uid, part.node, part.key, ctx.stanzaId, this.sock);
    try {
      const text = await geminiTranscribe(key, fs.readFileSync(file), (part.node.mimetype || 'audio/ogg').split(';')[0]);
      const cached = this.cache.get(ctx.stanzaId);
      const from = cached ? this.who(cached) : this.person(ctx.participant || chatId);
      this.bump('transcribed');
      this.log('info', `Transcribed a ${part.type} from ${from}`);
      const secs = part.node.seconds ? ` · ${part.node.seconds}s` : '';
      return `📝 *Transcript*${secs}\nFrom: ${from}\nChat: ${await this.chatLabel(chatId)}\n\n${text || '[No speech found]'}`;
    } finally { fs.unlink(file, () => {}); }
  }

  // ---------- commands (only messages YOU send) ----------
  async onCommand(msg, chatId, text) {
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const known = ['.vv', '.vvc', '.ping', '.help', '.ad', '.tag', '.tagall', '.block', '.unblock', '.transcribe', '.tr', '.admins'];
    if (!known.includes(cmd)) return false;
    const toSelf = (t) => this.sock.sendMessage(this.selfJid(), { text: t });
    const deleteCmd = async () => { if (!this.isSelf(chatId)) { try { await this.sock.sendMessage(chatId, { delete: msg.key }); } catch {} } };

    try {
      if (cmd === '.vv' || cmd === '.vvc') {
        const ctx = msg.message.extendedTextMessage?.contextInfo;
        const part = ctx?.quotedMessage ? media.mediaPart(ctx.quotedMessage) : null;
        const digits = args.join('').replace(/\D/g, '');
        if (!ctx?.quotedMessage && cmd === '.vv' && (digits.length >= 8 || (!chatId.endsWith('@g.us') && !this.isSelf(chatId) && chatId !== 'status@broadcast'))) {
          // .vv <number>  (or .vv in their private chat): fetch their latest view-once
          await this.vvLatest(digits.length >= 8 ? `${digits}@s.whatsapp.net` : (this.toPn(chatId) || jidNormalizedUser(chatId)));
        } else if (!part || !['image', 'video', 'audio'].includes(part.type)) {
          await toSelf('Reply to a view-once photo, video or voice note with .vv (to you) or .vvc (in that chat). Tip: reply *before* opening it.\n\nOr send *.vv +2348012345678* from here to get that person\'s latest view-once.');
        } else {
          const file = await media.downloadToFile(this.uid, part.node, part.key, ctx.stanzaId, this.sock);
          const cached = this.cache.get(ctx.stanzaId);
          const senderJid = ctx.participant || (chatId.endsWith('@g.us') ? null : chatId);
          const inChat = cmd === '.vvc';
          const { caption, mentions } = await this.viewOnceCaption(part, { senderJid, cached, chatId, inChat });
          await this.sendFile(inChat ? chatId : this.selfJid(), part, file, caption, mentions);
          this.bump('vv');
          this.log('info', `${cmd} sent a ${part.type} ${cmd === '.vv' ? 'to you' : 'into the chat'}`);
          fs.unlink(file, () => {});
        }
        await deleteCmd();
        return true;
      }
      if (cmd === '.ping') {
        const up = this.lastConnected ? Date.now() - this.lastConnected : 0;
        const h = Math.floor(up / 3600e3), mi = Math.floor((up % 3600e3) / 60e3);
        await Promise.all([toSelf(
          '✅ *Bot is online*\n\n' +
          `📱 +${num(this.me)}\n` +
          `⏱️ Connected for ${h ? h + 'h ' : ''}${mi}m\n\n` +
          '*Recovered in total*\n' +
          `🗑️ Deleted: ${this.stats.deleted}\n` +
          `✏️ Edited: ${this.stats.edited}\n` +
          `👁️ View-once: ${this.stats.vv + this.stats.viewOnce}\n` +
          `📝 Transcribed: ${this.stats.transcribed || 0}`), deleteCmd()]);
        return true;
      }
      // .tag all [text]  -> mentions everyone and lists their names
      // .tag [text]      -> mentions everyone silently (they get notified, no long list)
      // .tagall [text]   -> same as .tag all
      if (cmd === '.tag' || cmd === '.tagall') {
        if (!chatId.endsWith('@g.us')) { await Promise.all([toSelf('⚠️ *.tag* only works inside a group.'), deleteCmd()]); return true; }
        const listAll = cmd === '.tagall' || (args[0] || '').toLowerCase() === 'all';
        const words = listAll && cmd === '.tag' ? args.slice(1) : args;
        // a short cooldown per group so a slip of the thumb can't spam (and WhatsApp doesn't flag the account)
        this.tagCooldown = this.tagCooldown || new Map();
        const last = this.tagCooldown.get(chatId) || 0;
        if (Date.now() - last < 60e3) { await Promise.all([toSelf('⏳ *.tag* was used in that group less than a minute ago. Try again shortly.'), deleteCmd()]); return true; }
        const meta = await this.sock.groupMetadata(chatId);
        const mine = new Set([this.me, this.meLid].filter(Boolean).map((j) => j.split('@')[0].split(':')[0]));
        const people = meta.participants.map((p) => p.id).filter((j) => !mine.has(j.split('@')[0].split(':')[0]));
        if (!people.length) { await Promise.all([toSelf('⚠️ Nobody else is in that group to tag.'), deleteCmd()]); return true; }
        this.tagCooldown.set(chatId, Date.now());
        // if you replied to a message, tag everyone on top of that message
        const ctx = msg.message.extendedTextMessage?.contextInfo;
        const quoted = ctx?.quotedMessage ? { key: { remoteJid: chatId, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: ctx.quotedMessage } : undefined;
        const note = words.join(' ').trim();
        const body = listAll
          ? (note ? note + '\n\n' : '📢 *Everyone*\n\n') + people.map((j) => '@' + j.split('@')[0]).join(' ')
          : (note || '📢 Everyone, please see this.');
        await deleteCmd();
        await this.sock.sendMessage(chatId, { text: body, mentions: people }, quoted ? { quoted } : undefined);
        return true;
      }
      if (cmd === '.block' || cmd === '.unblock') {
        await deleteCmd();
        await toSelf(await this.blockCommand(cmd, msg, chatId, args));
        return true;
      }
      if (cmd === '.admins') {
        const r = await this.adminsCommand(msg, chatId, text);
        await deleteCmd();
        if (r.self) await toSelf(r.self);
        else await this.sock.sendMessage(chatId, r.group, r.quoted ? { quoted: r.quoted } : undefined);
        return true;
      }
      if (cmd === '.transcribe' || cmd === '.tr') {
        await deleteCmd();
        await toSelf(await this.transcribeCommand(msg, chatId));
        return true;
      }
      if (cmd === '.help') {
        await Promise.all([toSelf(
          '🤖 *WA Recovery commands*\n' +
          '_Send these yourself, in any chat._\n\n' +
          '*👁️ View-once*\n' +
          '• *.vv*  reply to a view-once and it comes here\n' +
          '• *.vvc*  reply to a view-once and it is posted in that chat\n' +
          '• *.vv 2348012345678*  when and where they last sent you a view-once\n\n' +
          '*⚙️ Settings for one chat*\n' +
          '• *.ad status*  see this chat\'s settings\n' +
          '• *.ad on* / *.ad off*  turn recovery on or off here\n' +
          '• *.ad off image*  turn off one type here\n' +
          '   _types: text, image, video, audio, sticker, document_\n' +
          '• *.ad reset*  use your dashboard settings again\n\n' +
          '*📢 Groups*\n' +
          '• *.tag all*  tag everyone, with their names listed\n' +
          '• *.tag your message*  notify everyone without the long list\n' +
          '   _reply to a message with .tag to tag everyone on it_\n\n' +
          '*🚫 Block for a while*\n' +
          '• *.block 2h*  reply to someone (or send it in their chat): blocked on WhatsApp, unblocked by itself after 2h\n' +
          '   _times: 30m, 2h, 1d, 1w · no time = until you .unblock_\n' +
          '• *.block 2348012345678 1d*  block by number\n' +
          '• *.unblock*  unblock now · *.block list*  who is blocked, time left\n\n' +
          '*👥 Group admins*\n' +
          '• *.admins your message*  posts it in the group with all the admins tagged\n' +
          '   _reply to a message with it to tag them on that message_\n\n' +
          '*📝 Voice notes*\n' +
          '• *.transcribe*  reply to a voice note and its text comes here\n\n' +
          '*🔧 Other*\n' +
          '• *.ping*  check the bot is online\n' +
          '• *.help*  show this list\n\n' +
          '_Deleted and edited messages arrive here by themselves._'), deleteCmd()]);
        return true;
      }
      if (cmd === '.ad') {
        const [a, b] = args.map((x) => (x || '').toLowerCase());
        const types = ['text', 'image', 'video', 'audio', 'sticker', 'document', 'viewonce'];
        const label = await this.chatLabel(chatId);
        let reply;
        if (a === 'on' || a === 'off') {
          const v = a === 'on';
          if (b && types.includes(b)) { ud.setChat(this.uid, chatId, { [b === 'viewonce' ? 'viewOnce' : b]: v }); reply = `${v ? '✅' : '❌'} *${b}* recovery turned ${v ? 'on' : 'off'} for ${label}.`; }
          else { ud.setChat(this.uid, chatId, { enabled: v }); reply = `${v ? '✅' : '❌'} Recovery turned ${v ? 'on' : 'off'} for ${label}.`; }
        } else if (a === 'reset') { ud.resetChat(this.uid, chatId); reply = `🔄 ${label} now uses your dashboard settings.`; }
        else {
          const c = ud.effective(this.uid, chatId);
          const NAMES = {"enabled": "Recovery here", "text": "Text", "image": "Photos", "video": "Videos", "audio": "Voice notes", "sticker": "Stickers", "document": "Documents", "viewOnce": "View-once", "statusDeleted": "Deleted statuses", "statusEdited": "Edited statuses", "saveMediaAhead": "Save media early"};
          reply = `⚙️ *Settings for ${label}*\n\n` + ud.KEYS.filter((k) => k !== 'privateChats' && k !== 'groups').map((k) => `${c[k] ? '✅' : '❌'} ${NAMES[k] || k}`).join('\n') + '\n\n_Change with .ad on / .ad off, or .ad reset_';
        }
        await Promise.all([toSelf(reply), deleteCmd()]); return true;
      }
    } catch (e) {
      this.log('error', `${cmd} failed: ${e.message}`);
      try { await toSelf(`⚠️ *${cmd} failed*\n${e.message}`); } catch {}
      await deleteCmd();
      return true;
    }
    return false;
  }
}

// ---------- manager ----------
function get(uid) {
  if (!sessions.has(uid)) sessions.set(uid, new Session(uid));
  return sessions.get(uid);
}
function hasAuth(uid) {
  try { return fs.existsSync(require('path').join(ud.authDir(uid), 'creds.json')); } catch { return false; }
}
/** Reconnect every enabled user who has linked WhatsApp before, a couple of seconds apart. */
async function startAll() {
  const users = db.listUsers().filter((u) => !u.disabled && hasAuth(u.id));
  for (const u of users) {
    get(u.id).start().catch((e) => ud.log(u.id, 'error', `Startup failed: ${e.message}`));
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`[sessions] started ${users.length} linked account(s)`);
}
async function remove(uid) {
  const s = sessions.get(uid);
  if (s) { await s.stop('Account removed'); sessions.delete(uid); }
}
function all() { return sessions; }

module.exports = { get, startAll, remove, all, hasAuth, Session, _helpers: { extractText, typeOf, isViewOnce, parseDuration, left } };
