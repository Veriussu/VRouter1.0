const crypto = require('crypto');
const config = require('./config');

const ALGO = 'aes-256-gcm';

function key() {
  return crypto.createHash('sha256').update(config.ENCRYPTION_KEY).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload) {
  try {
    const [ivB64, tagB64, dataB64] = String(payload).split(':');
    const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// API anahtarlarının kullanıcıya gösterilecek maskesi
function maskKey(plain) {
  const s = String(plain || '');
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

const hashKey = (plain) => crypto.createHash('sha256').update(String(plain)).digest('hex');

module.exports = { encrypt, decrypt, maskKey, hashKey };
