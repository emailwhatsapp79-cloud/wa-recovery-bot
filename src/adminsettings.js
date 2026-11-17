// Service-wide switches the admin controls from the admin page.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'admin-settings.json');
const DEFAULTS = {
  alerts: true,             // WhatsApp alerts when someone's link drops or errors pile up
  alertUsers: true,         // also message the affected user (from the admin's WhatsApp)
  backupToWhatsApp: false,  // send the daily backup file to the admin's "Message yourself" chat
  autoInvite: false,        // send invite codes to people who request one, without waiting for approval
};
let cur = null;
function get() {
  if (!cur) {
    try { cur = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { cur = { ...DEFAULTS }; }
  }
  return cur;
}
function set(patch) {
  const s = get();
  for (const k of Object.keys(DEFAULTS)) if (typeof patch[k] === 'boolean') s[k] = patch[k];
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  return s;
}
module.exports = { get, set, DEFAULTS };
