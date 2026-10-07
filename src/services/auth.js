const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');

const SESSION_COOKIE = 'vrouter_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();

function adminUser() {
  const username = getSetting('admin_username');
  const passwordHash = getSetting('admin_password_hash');
  return username && passwordHash ? { username, passwordHash } : null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expectedHex] = String(stored).split(':');
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hasAdmin() {
  return !!adminUser();
}

function register(username, password) {
  if (hasAdmin()) throw new Error('Yönetici hesabı zaten oluşturulmuş');
  const cleanUsername = String(username || '').trim();
  if (!/^[\p{L}\d._-]{3,40}$/u.test(cleanUsername)) {
    throw new Error('Kullanıcı adı 3-40 karakter olmalı');
  }
  if (String(password || '').length < 6) throw new Error('Şifre en az 6 karakter olmalı');
  setSetting('admin_username', cleanUsername);
  setSetting('admin_password_hash', hashPassword(String(password)));
  return { username: cleanUsername };
}

function login(username, password) {
  const user = adminUser();
  if (!user || user.username !== String(username || '').trim() || !verifyPassword(String(password || ''), user.passwordHash)) {
    return null;
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, expiresAt: Date.now() + SESSION_TTL_MS });
  return { token, username: user.username };
}

function logout(token) {
  if (token) sessions.delete(token);
}

function sessionFromRequest(req) {
  const header = req.headers.cookie || '';
  const token = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`))?.split('=').slice(1).join('=');
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { ...session, token };
}

function cookieOptions(req) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${req.secure ? '; Secure' : ''}`;
}

function clearCookie(req) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`;
}

function requireSession(req, res, next) {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Oturum gerekli', code: 'AUTH_REQUIRED' });
  req.admin = { username: session.username };
  next();
}

module.exports = {
  SESSION_COOKIE,
  adminUser,
  hasAdmin,
  register,
  login,
  logout,
  sessionFromRequest,
  cookieOptions,
  clearCookie,
  requireSession,
};
