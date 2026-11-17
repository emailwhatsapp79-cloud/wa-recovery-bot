// Passwords and login cookies.
// - Passwords are hashed with bcrypt (never stored in plain text).
// - The login cookie is "userId.expiry.tokenVersion.signature", signed with HMAC-SHA256.
//   Changing a password bumps tokenVersion, which logs that user out everywhere.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { SECRET, SESSION_DAYS } = require('./config');
const db = require('./db');

const COOKIE = 'wa_sess';

const hashPassword = (pw) => bcrypt.hash(String(pw), 10);
const checkPassword = (pw, hash) => bcrypt.compare(String(pw), hash || '');

function sign(s) { return crypto.createHmac('sha256', SECRET).update(s).digest('base64url'); }

function makeToken(user) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const body = `${user.id}.${exp}.${user.tokenVersion || 1}`;
  return `${body}.${sign(body)}`;
}

function readToken(tok) {
  if (!tok) return null;
  const parts = String(tok).split('.');
  if (parts.length !== 4) return null;
  const [uid, exp, ver, sig] = parts;
  const body = `${uid}.${exp}.${ver}`;
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Date.now() > Number(exp)) return null;
  const user = db.getUser(uid);
  if (!user || user.disabled || String(user.tokenVersion || 1) !== ver) return null;
  return user;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setLoginCookie(req, res, user) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(makeToken(user))}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearLoginCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Express middleware: attaches req.user if the cookie is valid.
function attachUser(req, _res, next) {
  req.user = readToken(parseCookies(req)[COOKIE]);
  next();
}
function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Please log in again.' });
  res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (req.user?.isAdmin) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(403).json({ error: 'Admins only.' });
  res.redirect(req.user ? '/dashboard' : '/login');
}

// Basic brute-force protection: max 10 failed logins per IP per 15 minutes.
const fails = new Map();
function tooManyFails(ip) {
  const r = fails.get(ip);
  if (!r) return false;
  if (Date.now() - r.first > 15 * 60e3) { fails.delete(ip); return false; }
  return r.count >= 10;
}
function noteFail(ip) {
  const r = fails.get(ip);
  if (!r || Date.now() - r.first > 15 * 60e3) fails.set(ip, { first: Date.now(), count: 1 });
  else r.count += 1;
}
function clearFails(ip) { fails.delete(ip); }

module.exports = {
  hashPassword, checkPassword, setLoginCookie, clearLoginCookie,
  attachUser, requireLogin, requireAdmin, tooManyFails, noteFail, clearFails,
};
