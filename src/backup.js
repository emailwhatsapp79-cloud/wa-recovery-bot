// Daily backups of everything needed to rebuild the service:
// accounts, invite codes, the login-cookie secret, and every user's WhatsApp login, settings,
// contacts and activity log. Saved media is NOT included (it's temporary and large).
//
// Backups go to data/backups/ (only the newest is kept; set BACKUP_KEEP to keep more). The admin can download one from the admin page,
// and can choose to have each one sent to their own WhatsApp so a copy lives off the server.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { DATA_DIR } = require('./config');
const adminSettings = require('./adminsettings');

const DIR = path.join(DATA_DIR, 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 1)); // just the newest backup, replaced daily
fs.mkdirSync(DIR, { recursive: true });

let running = null;
let lastResult = null; // { ok, file, at, sizeKb, error }

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function list() {
  try {
    return fs.readdirSync(DIR).filter((f) => /^backup-\d{8}-\d{6}\.tar\.gz$/.test(f)).sort().reverse()
      .map((f) => { const st = fs.statSync(path.join(DIR, f)); return { name: f, sizeKb: Math.round(st.size / 1024), at: st.mtimeMs }; });
  } catch { return []; }
}

function prune() {
  for (const b of list().slice(KEEP)) { try { fs.unlinkSync(path.join(DIR, b.name)); } catch {} }
}

/** Create a backup. `reason` is shown in logs. Resolves to { ok, file, ... }. */
function run(reason = 'scheduled') {
  if (running) return running;
  const name = `backup-${stamp()}.tar.gz`;
  const file = path.join(DIR, name);
  const tmp = file + '.part';
  running = new Promise((resolve) => {
    execFile('tar', [
      '-czf', tmp,
      '--exclude=./backups', '--exclude=./users/*/media', '--exclude=*.tmp', '--exclude=*.part',
      '-C', DATA_DIR, '.',
    ], { timeout: 5 * 60e3 }, async (err) => {
      if (err) {
        try { fs.unlinkSync(tmp); } catch {}
        lastResult = { ok: false, at: Date.now(), error: err.message, reason };
        console.error('[backup] failed:', err.message);
        return resolve(lastResult);
      }
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
      prune();
      const sizeKb = Math.round(fs.statSync(file).size / 1024);
      lastResult = { ok: true, file, name, at: Date.now(), sizeKb, reason };
      console.log(`[backup] ${name} (${sizeKb} KB, ${reason})`);
      if (adminSettings.get().backupToWhatsApp) {
        try { await require('./alerts').sendBackupToAdmins(file, name); lastResult.sentToWhatsApp = true; }
        catch (e) { lastResult.sentToWhatsApp = false; lastResult.sendError = e.message; }
      }
      resolve(lastResult);
    });
  }).finally(() => { running = null; });
  return running;
}

/** Run once a day around 03:00 server time, plus once shortly after startup if the newest backup is old. */
function schedule() {
  const tick = () => {
    const now = new Date();
    const newest = list()[0];
    const age = newest ? Date.now() - newest.at : Infinity;
    if ((now.getHours() === 3 && age > 3 * 3600e3) || age > 26 * 3600e3) run(age === Infinity ? 'first backup' : 'daily');
  };
  setTimeout(tick, 2 * 60e3).unref();
  setInterval(tick, 15 * 60e3).unref();
}

function pathOf(name) {
  if (!/^backup-\d{8}-\d{6}\.tar\.gz$/.test(name)) return null;
  const f = path.join(DIR, name);
  return fs.existsSync(f) ? f : null;
}

module.exports = { run, list, schedule, pathOf, last: () => lastResult, DIR };
