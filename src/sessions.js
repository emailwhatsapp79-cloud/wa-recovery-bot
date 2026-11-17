// One WhatsApp connection per user, plus all the recovery logic.
//
// Each user gets their own Baileys socket, auth folder, message cache and saved media.
// A crash or disconnect in one user's session never affects the others.
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore,
  Browsers, jidNormalizedUser, fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { MSG_CACHE_PER_USER } = require('./config');
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
const CMD_RE = /^\.(vvc?|ping|help|ad|tag(all)?|menu)(\s|$)/i;
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
    this.stats = { deleted: 0, edited: 0, viewOnce: 0, vv: 0, errors: 0, since: Date.now() };
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
    this.stats.errors++;
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
    clearTimeout(this.textSave); this.textSave = null; this.saveTextCache();
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
    const cfg = ud.effective(this.uid, chatId);
    if (!cfg.enabled || (isStatus && !cfg.statuses)) return;

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
          await this.sendFile(this.selfJid(), part, file, `👁️ *View-once ${part.type}*\nFrom: ${this.who(entry)}\nChat: ${await this.chatLabel(chatId)}`);
          this.stats.viewOnce++;
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
    if (type === 'text' && isCommandText(extractText(entry.message))) return;
    this.handled.add(key);
    const header = `🗑️ *Deleted ${type === 'text' ? 'message' : type}*\nFrom: ${this.who(entry)}\nChat: ${await this.chatLabel(entry.chatId)}`;
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
      this.stats.deleted++;
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
        text: `✏️ *Edited message*\nFrom: ${from}\nChat: ${await this.chatLabel(entry ? entry.chatId : chatId)}\n\n${body}`,
      });
      if (entry) entry.message = { conversation: after };
      else this.remember(id, { message: { conversation: after }, chatId, sender: meta.sender || chatId, senderPn: meta.alt, pushName: meta.pushName, t: Date.now(), file: null });
      this.stats.edited++;
      this.log('info', `Recovered an edit from ${from}${before === null ? ' (original not seen)' : ''}`);
    } catch (e) { this.log('error', `Couldn't send an edit: ${e.message}`); }
  }

  async sendFile(to, part, file, caption) {
    const src = { url: file };
    if (part.type === 'image') return this.sock.sendMessage(to, { image: src, caption });
    if (part.type === 'video') return this.sock.sendMessage(to, { video: src, caption });
    if (part.type === 'sticker') { await this.sock.sendMessage(to, { sticker: src }); return caption && this.sock.sendMessage(to, { text: caption }); }
    if (part.type === 'audio') {
      await this.sock.sendMessage(to, { audio: src, mimetype: part.node.mimetype || 'audio/ogg; codecs=opus', ptt: !!part.node.ptt });
      return caption && this.sock.sendMessage(to, { text: caption });
    }
    return this.sock.sendMessage(to, { document: src, mimetype: part.node.mimetype || 'application/octet-stream', fileName: part.node.fileName || 'file', caption });
  }

  // ---------- commands (only messages YOU send) ----------
  async onCommand(msg, chatId, text) {
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const known = ['.vv', '.vvc', '.ping', '.help', '.ad', '.tag', '.tagall'];
    if (!known.includes(cmd)) return false;
    const toSelf = (t) => this.sock.sendMessage(this.selfJid(), { text: t });
    const deleteCmd = async () => { if (!this.isSelf(chatId)) { try { await this.sock.sendMessage(chatId, { delete: msg.key }); } catch {} } };

    try {
      if (cmd === '.vv' || cmd === '.vvc') {
        const ctx = msg.message.extendedTextMessage?.contextInfo;
        const part = ctx?.quotedMessage ? media.mediaPart(ctx.quotedMessage) : null;
        if (!part || !['image', 'video', 'audio'].includes(part.type)) {
          await toSelf('Reply to a view-once photo, video or voice note with .vv (to you) or .vvc (in that chat). Tip: reply *before* opening it.');
        } else {
          const file = await media.downloadToFile(this.uid, part.node, part.key, ctx.stanzaId, this.sock);
          const cached = this.cache.get(ctx.stanzaId);
          const from = cached ? this.who(cached) : this.person(ctx.participant || chatId);
          if (cmd === '.vv') {
            await this.sendFile(this.selfJid(), part, file, `👁️ View-once from ${from}\n${chatId.endsWith('@g.us') ? 'Group: ' + await this.chatLabel(chatId) : ''}${part.node.caption ? '\n\n' + part.node.caption : ''}`);
          } else {
            await this.sendFile(chatId, part, file, part.node.caption || '');
          }
          this.stats.vv++;
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
          '*Recovered since start*\n' +
          `🗑️ Deleted: ${this.stats.deleted}\n` +
          `✏️ Edited: ${this.stats.edited}\n` +
          `👁️ View-once: ${this.stats.vv}`), deleteCmd()]);
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
      if (cmd === '.help') {
        await Promise.all([toSelf(
          '🤖 *WA Recovery commands*\n' +
          '_Send these yourself, in any chat._\n\n' +
          '*👁️ View-once*\n' +
          '• *.vv*  reply to a view-once and it comes here\n' +
          '• *.vvc*  reply to a view-once and it is posted in that chat\n\n' +
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
          const NAMES = {"enabled": "Recovery here", "text": "Text", "image": "Photos", "video": "Videos", "audio": "Voice notes", "sticker": "Stickers", "document": "Documents", "viewOnce": "View-once", "statuses": "Statuses", "saveMediaAhead": "Save media early"};
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

module.exports = { get, startAll, remove, all, hasAuth, Session, _helpers: { extractText, typeOf, isViewOnce } };
