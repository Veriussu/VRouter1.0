const crypto = require('crypto');
const { db } = require('../db');
const { encrypt, hashKey, maskKey } = require('../crypto');

const uid = () => crypto.randomUUID();

/**
 * Yerleşik sağlayıcılar: models.dev'de bulunmayan, kullanıcıya özel olanlar.
 * base_url kullanıcı tarafından güncellenebilir.
 */
/**
 * Şablon sağlayıcılar — kullanıcı "Sağlayıcı Ekle" modalında
 * VProvider veya Local seçtiğinde bu bilgilerle yeni kayıt oluşur.
 * base_url, kullanıcı tarafından girmek üzere yer tutucu olarak tutulur.
 */
const BUILTINS = [
  {
    slug: 'local',
    name: 'Local (Ollama / LM Studio / vLLM)',
    base_url: 'http://127.0.0.1:11434/v1',
    api_format: 'openai',
    docs_url: 'https://ollama.com',
    metadata: { hint: 'Yerel sunucu adresini base_url olarak güncelleyin', is_template: true, template_type: 'local' },
  },
  {
    slug: 'vprovider',
    name: 'VProvider',
    base_url: '',
    api_format: 'openai',
    docs_url: null,
    metadata: { hint: 'API anahtarı girmek üzere boş bırakılacak', is_template: true, template_type: 'vprovider' },
  },
];

function ensureBuiltins() {
  const stmt = db.prepare(`
    INSERT INTO providers (id, name, slug, base_url, api_format, docs_url, is_builtin, metadata)
    VALUES (@id, @name, @slug, @base_url, @api_format, @docs_url, 1, @metadata)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      docs_url = excluded.docs_url,
      updated_at = datetime('now')
  `);
  const tx = db.transaction(() => {
    for (const b of BUILTINS) {
      // Kullanıcı silmişse yeniden canlandırma
      const existing = db.prepare('SELECT is_deleted FROM providers WHERE slug = ?').get(b.slug);
      if (existing && existing.is_deleted) continue;

      // ON CONFLICT sadece ad/docs günceller; base_url ve is_deleted korunur
      stmt.run({
        id: b.slug,
        name: b.name,
        slug: b.slug,
        base_url: b.base_url,
        api_format: b.api_format,
        docs_url: b.docs_url,
        metadata: JSON.stringify(b.metadata),
      });
    }
  });
  tx();
}

function listProviders({ includeDeleted = false } = {}) {
  return db
    .prepare(
       `SELECT p.*,
              (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id) AS model_count,
              (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id AND m.is_available = 1) AS available_model_count,
              (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id AND m.is_active = 1) AS active_model_count,
              (SELECT COUNT(*) FROM provider_api_keys k WHERE k.provider_id = p.id) AS key_count,
              (SELECT COUNT(*) FROM provider_api_keys k WHERE k.provider_id = p.id AND k.status = 'active') AS active_key_count
       FROM providers p
       ${includeDeleted ? '' : 'WHERE p.is_deleted = 0'}
       ORDER BY p.is_deleted ASC, p.is_builtin DESC, p.name ASC`
    )
    .all();
}

function getProvider(slugOrId) {
  return db.prepare('SELECT * FROM providers WHERE slug = ? OR id = ?').get(slugOrId, slugOrId);
}

function createProvider({ name, slug, base_url, api_format, docs_url }) {
  if (!name || !slug) throw new Error('name ve slug zorunlu');
  const exists = getProvider(slug);
  if (exists) throw new Error('Bu slug ile bir sağlayıcı zaten var');

  const id = uid();
  const stmt = db.prepare(`
    INSERT INTO providers (id, name, slug, base_url, api_format, docs_url, is_builtin, metadata)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `);
  stmt.run(id, name, slug, base_url, api_format, docs_url, JSON.stringify({}));
  return getProvider(id);
}

function updateProvider(id, updates) {
  const provider = getProvider(id);
  if (!provider) return false;

  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.slug !== undefined) {
    fields.push('slug = ?');
    values.push(updates.slug);
  }
  if (updates.base_url !== undefined) {
    fields.push('base_url = ?');
    values.push(updates.base_url);
  }
  if (updates.api_format !== undefined) {
    fields.push('api_format = ?');
    values.push(updates.api_format);
  }
  if (updates.docs_url !== undefined) {
    fields.push('docs_url = ?');
    values.push(updates.docs_url);
  }
  if (updates.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(JSON.stringify(updates.metadata));
  }

  if (fields.length === 0) return true;

  values.push(id);
  const stmt = db.prepare(`UPDATE providers SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`);
  stmt.run(...values);
  return true;
}

function deleteProvider(slugOrId) {
  const p = getProvider(slugOrId);
  if (!p) return { ok: false, reason: 'Sağlayıcı bulunamadı' };
  if (p.is_deleted) return { ok: false, reason: 'Sağlayıcı zaten silinmiş' };

  const keys = db
    .prepare('SELECT COUNT(*) AS n FROM provider_api_keys WHERE provider_id = ?')
    .get(p.id).n;

  // Anahtarları pasifleştir ki geri getirildiğinde temiz başlasın
  db.prepare(
    `UPDATE provider_api_keys SET status = 'disabled', cooldown_until = NULL
     WHERE provider_id = ? AND status != 'disabled'`
  ).run(p.id);

  db.prepare(
    `UPDATE providers SET is_deleted = 1, is_active = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(p.id);

  return { ok: true, name: p.name, keys };
}

/** Silinen sağlayıcıyı geri getirir; anahtarları yeniden etkinleştirir. */
function restoreProvider(slugOrId) {
  const p = getProvider(slugOrId);
  if (!p) return { ok: false, reason: 'Sağlayıcı bulunamadı' };
  if (!p.is_deleted) return { ok: false, reason: 'Sağlayıcı silinmemiş' };

  db.prepare(
    `UPDATE provider_api_keys SET status = 'active', error_count = 0
     WHERE provider_id = ? AND status = 'disabled'`
  ).run(p.id);

  db.prepare(
    `UPDATE providers SET is_deleted = 0, is_active = 1, updated_at = datetime('now') WHERE id = ?`
  ).run(p.id);

  const keys = db
    .prepare(`SELECT COUNT(*) AS n FROM provider_api_keys WHERE provider_id = ? AND status = 'active'`)
    .get(p.id).n;

  return { ok: true, name: p.name, keys };
}

/** Kalıcı silme — geri alınamaz. Silinmiş sağlayıcılar içindir. */
function purgeProvider(slugOrId) {
  const p = getProvider(slugOrId);
  if (!p) return { ok: false, reason: 'Sağlayıcı bulunamadı' };
  if (!p.is_deleted) return { ok: false, reason: 'Önce silinmesi gerekir' };
  db.prepare('DELETE FROM providers WHERE id = ?').run(p.id);
  return { ok: true, name: p.name };
}

module.exports = {
  ensureBuiltins,
  listProviders,
  getProvider,
  isUsable: (provider) => !!provider && !provider.is_deleted && !!provider.is_active,
  createProvider,
  updateProvider,
  deleteProvider,
  restoreProvider,
  purgeProvider,
  addKey,
  listKeys,
  deleteKey,
  setKeyStatus,
  allKeys,
  providerKeyState,
};

/* ---------------------------- API anahtarları ---------------------------- */

/**
 * Sağlayıcıya API anahtarı ekle.
 * @returns {Array} listKeys
 */
function addKey(providerId, { key, key_name, priority = 0 }) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error('Sağlayıcı bulunamadı');

  const id = uid();
  const encrypted = encrypt(key);
  const masked = maskKey(key);
  const hashed = hashKey(key);

  const stmt = db.prepare(`
    INSERT INTO provider_api_keys
      (id, provider_id, key_encrypted, key_hash, key_mask, key_name, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `);
  stmt.run(id, providerId, encrypted, hashed, masked, key_name, priority);

  return listKeys(providerId);
}

/** Sağlayıcının anahtar listesi. */
function listKeys(providerId) {
  return db
    .prepare(
      `SELECT id, key_mask, key_name, priority, status, cooldown_until,
              error_count, usage_count, last_used_at, created_at
       FROM provider_api_keys
       WHERE provider_id = ?
       ORDER BY priority ASC, created_at ASC`
    )
    .all(providerId);
}

/** Anahtar siler. */
function deleteKey(keyId) {
  const info = db.prepare('DELETE FROM provider_api_keys WHERE id = ?').run(keyId);
  return info.changes > 0;
}

/** Anahtar durumunu değiştirir (active | disabled | cooldown | invalid). */
function setKeyStatus(keyId, status) {
  const allowed = ['active', 'disabled', 'cooldown', 'invalid'];
  if (!allowed.includes(status)) throw new Error('Geçersiz durum: ' + status);
  db.prepare('UPDATE provider_api_keys SET status = ? WHERE id = ?').run(status, keyId);
}

/** Tüm sağlayıcıların anahtarları (yönetim). */
function allKeys() {
  return db
    .prepare(
      `SELECT k.*, p.name AS provider_name, p.slug AS provider_slug
       FROM provider_api_keys k
       JOIN providers p ON p.id = k.provider_id
       ORDER BY p.name ASC, k.priority ASC`
    )
    .all();
}

/** Rotasyon için providerKeyState — keyRotator'ın beklediği şekilde. */
function providerKeyState(providerId) {
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM provider_api_keys WHERE provider_id = ?')
    .get(providerId).n;
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM provider_api_keys
       WHERE provider_id = ? AND status = 'active' AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))`
    )
    .get(providerId).n;
  const cooldown = db
    .prepare(
      `SELECT COUNT(*) AS n FROM provider_api_keys
       WHERE provider_id = ? AND status = 'cooldown' AND cooldown_until > datetime('now')`
    )
    .get(providerId).n;
  const invalid = db
    .prepare('SELECT COUNT(*) AS n FROM provider_api_keys WHERE provider_id = ? AND status = ?')
    .get(providerId, 'invalid').n;
  return { total, active, cooldown, invalid };
}
