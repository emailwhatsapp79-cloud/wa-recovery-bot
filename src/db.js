// Tiny JSON-file database for accounts and invite codes.
// Writes are atomic (write temp file, then rename) so a crash can't corrupt it.
// For an invite-only service with tens of users this is plenty; it can be swapped
// for SQLite later without touching the rest of the app (only this file talks to disk).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'db.json');
let data = { users: [], invites: [] };

function load() {
  if (fs.existsSync(FILE)) {
    try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) {
      // keep the broken file for inspection, start fresh rather than crash
      fs.copyFileSync(FILE, FILE + '.corrupt-' + Date.now());
      console.error('[db] db.json unreadable, saved a copy and started empty:', e.message);
    }
  }
  data.users ||= [];
  data.invites ||= [];
  data.requests ||= [];
}
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
load();

const id = () => crypto.randomBytes(8).toString('hex');
const norm = (e) => String(e || '').trim().toLowerCase();

// ---------- users ----------
function listUsers() { return data.users; }
function getUser(uid) { return data.users.find((u) => u.id === uid) || null; }
function getUserByEmail(email) { return data.users.find((u) => u.email === norm(email)) || null; }
function createUser({ email, passHash, isAdmin = false, invite = null }) {
  const u = {
    id: id(), email: norm(email), passHash, isAdmin, disabled: false,
    invite, createdAt: Date.now(), tokenVersion: 1, phone: null,
  };
  data.users.push(u); save(); return u;
}
function updateUser(uid, patch) {
  const u = getUser(uid); if (!u) return null;
  Object.assign(u, patch); save(); return u;
}
function deleteUser(uid) {
  data.users = data.users.filter((u) => u.id !== uid); save();
}
function hasAdmin() { return data.users.some((u) => u.isAdmin); }

// ---------- invites ----------
function makeCode() {
  // 10 chars, no look-alike letters (0/O, 1/I/L) so it's easy to type on a phone
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.randomBytes(10);
  for (const b of bytes) s += abc[b % abc.length];
  return s.slice(0, 5) + '-' + s.slice(5);
}
function createInvite({ note = '', createdBy = null, admin = false, uses = 1 }) {
  const inv = { code: makeCode(), note: String(note).slice(0, 80), createdBy, admin, usesLeft: uses, createdAt: Date.now(), usedBy: [] };
  data.invites.push(inv); save(); return inv;
}
function listInvites() { return data.invites; }
function findInvite(code) {
  const c = String(code || '').trim().toUpperCase();
  return data.invites.find((i) => i.code === c && i.usesLeft > 0) || null;
}
function consumeInvite(code, userId) {
  const inv = findInvite(code); if (!inv) return null;
  inv.usesLeft -= 1; inv.usedBy.push(userId); save(); return inv;
}
function revokeInvite(code) {
  const inv = data.invites.find((i) => i.code === code);
  if (inv && inv.usesLeft > 0) { inv.usesLeft = 0; inv.revoked = true; inv.revokedAt = Date.now(); save(); }
}

// ---------- invite requests (people without a code asking for one) ----------
function listRequests() { return data.requests; }
function pendingRequestFor(phone) { return data.requests.find((r) => r.phone === phone && r.status === 'pending') || null; }
function addRequest({ name, phone }) {
  const r = { id: id(), name: String(name || '').trim().slice(0, 60), phone, status: 'pending', createdAt: Date.now() };
  data.requests.push(r);
  if (data.requests.length > 500) data.requests.splice(0, data.requests.length - 500);
  save(); return r;
}
function updateRequest(rid, patch) {
  const r = data.requests.find((x) => x.id === rid); if (!r) return null;
  Object.assign(r, patch, { updatedAt: Date.now() }); save(); return r;
}

module.exports = {
  listUsers, getUser, getUserByEmail, createUser, updateUser, deleteUser, hasAdmin,
  createInvite, listInvites, findInvite, consumeInvite, revokeInvite,
  listRequests, pendingRequestFor, addRequest, updateRequest,
};
