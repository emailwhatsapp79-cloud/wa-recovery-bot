// Saving media as it arrives, so it can still be sent to you after the sender deletes it.
// Files are streamed straight to disk (never held whole in memory), size-capped,
// and cleaned up automatically after MEDIA_KEEP_HOURS or when a user's folder gets too big.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { MEDIA_MAX_MB, MEDIA_KEEP_HOURS, MEDIA_USER_CAP_MB } = require('./config');
const ud = require('./userdata');
const logger = require('pino')({ level: 'silent' });

const MEDIA_KINDS = {
  imageMessage: { type: 'image', ext: 'jpg' },
  videoMessage: { type: 'video', ext: 'mp4' },
  audioMessage: { type: 'audio', ext: 'ogg' },
  stickerMessage: { type: 'sticker', ext: 'webp' },
  documentMessage: { type: 'document', ext: 'bin' },
};

/** Find the media part of a message (unwrapping view-once / ephemeral / document-with-caption wrappers). */
function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner =
      m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message ||
      m.ephemeralMessage?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

function mediaPart(message) {
  const m = unwrap(message) || {};
  for (const [key, info] of Object.entries(MEDIA_KINDS)) {
    if (m[key]) return { key, node: m[key], ...info };
  }
  return null;
}

const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

/**
 * Stream a message's media to disk. Returns the file path, or null if skipped.
 * Throws on download errors (caller logs them).
 */
async function saveAhead(uid, msg, sock) {
  const part = mediaPart(msg.message);
  if (!part) return null;
  const sizeMb = Number(part.node.fileLength || 0) / 1048576;
  if (sizeMb > MEDIA_MAX_MB) {
    ud.log(uid, 'warn', `Skipped saving a ${part.type} of ${sizeMb.toFixed(0)} MB (limit ${MEDIA_MAX_MB} MB)`);
    return null;
  }
  const ext = part.type === 'document' ? (path.extname(part.node.fileName || '').slice(1) || 'bin').slice(0, 8) : part.ext;
  const file = path.join(ud.mediaDir(uid), `${safeName(msg.key.id)}.${safeName(ext) || 'bin'}`);
  if (fs.existsSync(file)) return file;
  const stream = await downloadMediaMessage(
    { key: msg.key, message: { [part.key]: part.node } },
    'stream', {},
    sock ? { reuploadRequest: sock.updateMediaMessage, logger } : { logger }
  );
  const tmp = file + '.part';
  await pipeline(stream, fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  return file;
}

/** Download media straight into memory-free file, used by .vv on a quoted message. */
async function downloadToFile(uid, node, kindKey, idHint, sock) {
  const info = MEDIA_KINDS[kindKey];
  const file = path.join(ud.mediaDir(uid), `vv-${safeName(idHint || Date.now())}-${Date.now()}.${info.ext}`);
  const stream = await downloadMediaMessage(
    { key: { id: idHint }, message: { [kindKey]: node } }, 'stream', {},
    sock ? { reuploadRequest: sock.updateMediaMessage, logger } : { logger }
  );
  await pipeline(stream, fs.createWriteStream(file));
  return file;
}

/** Delete expired media, then trim oldest files if a user is over their disk cap. */
function cleanup() {
  const now = Date.now();
  let users = [];
  try { users = fs.readdirSync(ud.USERS_DIR); } catch { return; }
  for (const uid of users) {
    const dir = path.join(ud.USERS_DIR, uid, 'media');
    let files = [];
    try {
      files = fs.readdirSync(dir).map((f) => {
        const p = path.join(dir, f); const st = fs.statSync(p);
        return { p, size: st.size, mtime: st.mtimeMs };
      });
    } catch { continue; }
    let total = 0;
    const keep = [];
    for (const f of files) {
      if (now - f.mtime > MEDIA_KEEP_HOURS * 3600e3 || f.p.endsWith('.part') && now - f.mtime > 3600e3) {
        try { fs.unlinkSync(f.p); } catch {}
      } else { keep.push(f); total += f.size; }
    }
    keep.sort((a, b) => a.mtime - b.mtime);
    while (total > MEDIA_USER_CAP_MB * 1048576 && keep.length) {
      const f = keep.shift();
      try { fs.unlinkSync(f.p); } catch {}
      total -= f.size;
    }
  }
}
setInterval(cleanup, 30 * 60e3).unref();
setTimeout(cleanup, 60e3).unref();

function dirSizeMb(dir) {
  let total = 0;
  try { for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size; } catch {}
  return total / 1048576;
}

module.exports = { MEDIA_KINDS, unwrap, mediaPart, saveAhead, downloadToFile, cleanup, dirSizeMb };
