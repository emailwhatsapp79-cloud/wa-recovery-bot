// Per-user folders, settings and activity/error log.
//
// data/users/<userId>/
//   auth/            WhatsApp login keys (Baileys multi-file auth state)
//   media/           media saved in advance so deleted photos/videos can be resent
//   settings.json    what to recover, globally and per chat
//   events.json      last N activity/error lines (shown on the dashboard)
const fs = require('fs');
const path = require('path');
const { DATA_DIR, LOG_KEEP } = require('./config');

const USERS_DIR = path.join(DATA_DIR, 'users');
fs.mkdirSync(USERS_DIR, { recursive: true });

function userDir(uid) {
  if (!/^[a-f0-9]{16}$/.test(uid)) throw new Error('bad user id');
  const d = path.join(USERS_DIR, uid);
  fs.mkdirSync(path.join(d, 'media'), { recursive: true });
  return d;
}
const authDir = (uid) => path.join(userDir(uid), 'auth');
const mediaDir = (uid) => path.join(userDir(uid), 'media');

function removeUserData(uid) {
  fs.rmSync(path.join(USERS_DIR, uid), { recursive: true, force: true });
}
function removeAuth(uid) {
  fs.rmSync(authDir(uid), { recursive: true, force: true });
}

// ---------- settings ----------
const DEFAULTS = {
  enabled: true,     // master switch
  privateChats: true, // one-to-one chats
  groups: false,      // group chats (off by default; turn on from the dashboard)
  text: true,        // deleted + edited text
  image: true,
  video: true,
  audio: true,
  sticker: true,
  document: true,
  viewOnce: true,    // try to auto-save view-once (WhatsApp often blocks this for linked devices; .vv always works)
  statuses: false,   // recover deleted WhatsApp statuses (noisy, off by default)
  saveMediaAhead: true, // download media as it arrives so it can be resent after deletion
};
const KEYS = Object.keys(DEFAULTS);

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function writeJson(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

const settingsCache = new Map();
function loadSettings(uid) {
  if (!settingsCache.has(uid)) {
    const s = readJson(path.join(userDir(uid), 'settings.json'), {});
    settingsCache.set(uid, { global: { ...DEFAULTS, ...(s.global || {}) }, chats: s.chats || {} });
  }
  return settingsCache.get(uid);
}
function saveSettings(uid) {
  writeJson(path.join(userDir(uid), 'settings.json'), loadSettings(uid));
}
function effective(uid, chatId) {
  const s = loadSettings(uid);
  const own = s.chats[chatId] || {};
  const eff = { ...s.global, ...own };
  // "All groups" / "All private chats" switches. A chat you turned on yourself with ".ad on" still wins.
  if (own.enabled === undefined && s.global.enabled && chatId && chatId !== 'status@broadcast') {
    const isGroup = chatId.endsWith('@g.us');
    eff.enabled = isGroup ? s.global.groups !== false : s.global.privateChats !== false;
  }
  if (!s.global.enabled) eff.enabled = false; // master switch always wins
  return eff;
}
function setGlobal(uid, patch) {
  const s = loadSettings(uid);
  for (const k of KEYS) if (typeof patch[k] === 'boolean') s.global[k] = patch[k];
  saveSettings(uid); return s.global;
}
function setChat(uid, chatId, patch) {
  const s = loadSettings(uid);
  s.chats[chatId] ||= {};
  for (const k of KEYS) if (typeof patch[k] === 'boolean') s.chats[chatId][k] = patch[k];
  saveSettings(uid); return effective(uid, chatId);
}
function resetChat(uid, chatId) {
  const s = loadSettings(uid); delete s.chats[chatId]; saveSettings(uid);
}

// ---------- activity / error log ----------
// Kept in memory, flushed to disk at most every few seconds.
const logs = new Map();
const dirty = new Set();
function getLog(uid) {
  if (!logs.has(uid)) logs.set(uid, readJson(path.join(userDir(uid), 'events.json'), []));
  return logs.get(uid);
}
function log(uid, level, msg) {
  const arr = getLog(uid);
  arr.push({ t: Date.now(), level, msg: String(msg).slice(0, 300) });
  if (arr.length > LOG_KEEP) arr.splice(0, arr.length - LOG_KEEP);
  dirty.add(uid);
  if (level === 'error') console.error(`[user ${uid.slice(0, 6)}] ${msg}`);
}
function flushLogs() {
  for (const uid of dirty) {
    try { writeJson(path.join(userDir(uid), 'events.json'), getLog(uid)); } catch {}
  }
  dirty.clear();
}
setInterval(flushLogs, 5000).unref();
process.on('exit', flushLogs);

module.exports = {
  USERS_DIR, userDir, authDir, mediaDir, removeUserData, removeAuth,
  DEFAULTS, KEYS, loadSettings, effective, setGlobal, setChat, resetChat,
  log, getLog, flushLogs,
};
