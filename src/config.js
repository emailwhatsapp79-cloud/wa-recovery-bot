// All tunables in one place. Every value can be overridden with an environment variable.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// Secret used to sign login cookies. Generated once and kept in data/secret.key.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  PORT: num(process.env.PORT, 8080),
  DATA_DIR,
  SECRET: loadSecret(),
  APP_NAME: process.env.APP_NAME || 'WA Recovery',

  // capacity / safety limits
  MAX_USERS: num(process.env.MAX_USERS, 30),
  PUBLIC_URL: (process.env.PUBLIC_URL || 'https://wa-recovery-bot.vercel.app').replace(/\/$/, ''), // used in links sent on WhatsApp                 // accounts allowed in total
  MEDIA_MAX_MB: num(process.env.MEDIA_MAX_MB, 64),           // biggest single file saved in advance
  MEDIA_KEEP_HOURS: num(process.env.MEDIA_KEEP_HOURS, 72),   // saved media is deleted after this
  MEDIA_USER_CAP_MB: num(process.env.MEDIA_USER_CAP_MB, 600),   // per-user disk cap for saved media
  MSG_CACHE_PER_USER: num(process.env.MSG_CACHE_PER_USER, 4000),
  SESSION_DAYS: num(process.env.SESSION_DAYS, 30),            // how long a login lasts
  LOG_KEEP: num(process.env.LOG_KEEP, 300),                   // activity-log lines kept per user
};
