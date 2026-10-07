const { db } = require('../db');
const { decrypt } = require('../crypto');

/**
 * Sağlayıcı API anahtarı rotasyonu.
 *
 * Kurallar:
 *  - Bir sağlayıcıya birden fazla anahtar tanımlanabilir.
 *  - Hata sınıfına göre anahtar "soğutulur" veya devre dışı bırakılır.
 *  - Soğuma süresi dolan anahtar otomatik tekrar denenir.
 *  - Tüm anahtarlar kullanılamaz durumdaysa null döner (429 üretilir).
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// Anahtarın devre dışı kalacağı süre (hata sınıfına göre, saniye)
const COOLDOWN = {
  invalid: 3600,      // 401 / 403 - anahtar iptal edilmiş olabilir
  forbidden: 3600,
  quota: 300,         // 402 - kredi bitti
  rate_limit: 60,     // 429 - kısa süre bekle
  server: 30,         // 5xx
  network: 15,        // bağlantı hatası
};

/** Sağlayıcı için kullanılabilir anahtar listesi (öncelik + cooldown durumu) */
function availableKeys(providerId) {
  return db
    .prepare(
      `SELECT id, key_encrypted, priority, status, cooldown_until, error_count
       FROM provider_api_keys
       WHERE provider_id = ?
         AND status != 'disabled'
         AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
       ORDER BY priority ASC, created_at ASC`
    )
    .all(providerId);
}

function keyCount(providerId) {
  return db.prepare('SELECT COUNT(*) AS n FROM provider_api_keys WHERE provider_id = ?').get(providerId).n;
}

/** Bir anahtarı kullanıldı olarak işaretle */
function markUsed(keyId) {
  db.prepare(
    `UPDATE provider_api_keys
     SET usage_count = usage_count + 1,
         last_used_at = datetime('now'),
         status = CASE WHEN status = 'cooldown' THEN 'active' ELSE status END
     WHERE id = ?`
  ).run(keyId);
}

/**
 * Hatayı sınıflandır.
 * @returns {{kind:string, message:string, retryable:boolean}}
 */
function classifyError(status, bodyText = '') {
  const body = String(bodyText || '').toLowerCase();

  if (status === 401) return { kind: 'invalid', message: 'API anahtarı geçersiz', retryable: true };
  if (status === 403) return { kind: 'forbidden', message: 'Erişim reddedildi', retryable: true };
  if (status === 402) return { kind: 'quota', message: 'Kota / kredi limiti doldu', retryable: true };

  if (status === 429) {
    const quotaish = /quota|billing|credit|insufficient|exceeded your current quota/.test(body);
    return {
      kind: quotaish ? 'quota' : 'rate_limit',
      message: quotaish ? 'Kota aşıldı' : 'İstek limiti aşıldı',
      retryable: true,
    };
  }

  if (status >= 500) return { kind: 'server', message: `Sağlayıcı hatası (${status})`, retryable: true };
  if (status === 408 || status === 425) return { kind: 'network', message: 'Zaman aşımı', retryable: true };

  // 400 / 404 / 422 -> istek hatası, başka anahtar denemek anlamsız
  return { kind: 'client', message: `İstek hatası (${status})`, retryable: false };
}

/**
 * Hata durumunda anahtarı soğut.
 * Retry-After başlığı varsa onu kullanır.
 */
function coolDown(keyId, kind, { retryAfter, errorCount = 1, message = '' } = {}) {
  let seconds = COOLDOWN[kind] ?? 30;

  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n) && n > 0) seconds = Math.max(seconds, n);
  }
  // Ardışık hatalarda süreyi kademeli artır (üst sınır 1 saat)
  if (errorCount > 1) seconds = Math.min(3600, seconds * Math.min(errorCount, 4));

  db.prepare(
    `UPDATE provider_api_keys
     SET status = CASE WHEN ? = 'invalid' THEN 'invalid' ELSE 'cooldown' END,
         cooldown_until = datetime('now', '+' || ? || ' seconds'),
         rate_limit_reset_at = datetime('now', '+' || ? || ' seconds'),
         error_count = error_count + 1,
         last_error = ?
     WHERE id = ?`
  ).run(kind, Math.round(seconds), Math.round(seconds), String(message).slice(0, 500), keyId);
}

/** Soğuma süresi dolmuş anahtarları yeniden aktifleştir */
function reviveCooldowns() {
  const info = db
    .prepare(
      `UPDATE provider_api_keys
       SET status = 'active', error_count = 0, cooldown_until = NULL
       WHERE status = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= datetime('now')`
    )
    .run();
  return info.changes;
}

/** Sağlayıcının kullanılabilir anahtar durumu özeti */
function providerKeyState(providerId) {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN status = 'cooldown' THEN 1 ELSE 0 END), 0) AS cooldown,
         COALESCE(SUM(CASE WHEN status = 'invalid'  THEN 1 ELSE 0 END), 0) AS invalid,
         COALESCE(SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END), 0) AS disabled
       FROM provider_api_keys WHERE provider_id = ?`
    )
    .get(providerId);
}

module.exports = {
  availableKeys,
  keyCount,
  markUsed,
  classifyError,
  coolDown,
  reviveCooldowns,
  providerKeyState,
  decrypt,
};
