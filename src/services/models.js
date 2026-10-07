const { db } = require('../db');

/**
 * Model adı çözümleme ve yönlendirme.
 *
 * Öncelik sırası:
 *  1. Kullanıcı alias'ı (takma ad) -> tek model
 *  2. Tam orijinal ad -> provider + model
 *  3. "provider/model" biçimi
 *  4. Benzersiz eşleşme (sağlayıcı belirtilmemişse)
 */

function allModels({ activeOnly = true, availableOnly = false, withActiveKey = false } = {}) {
  const conditions = [];
  if (activeOnly) conditions.push('m.is_active = 1');
  conditions.push('p.is_deleted = 0');
  if (availableOnly) conditions.push('m.is_available = 1');
  if (withActiveKey) {
    conditions.push(`EXISTS (
      SELECT 1 FROM provider_api_keys pk
      WHERE pk.provider_id = p.id
        AND pk.status = 'active'
        AND (pk.cooldown_until IS NULL OR pk.cooldown_until <= datetime('now'))
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT m.*, p.slug AS provider_slug, p.name AS provider_name, p.base_url,
              p.api_format, p.is_active AS provider_active
       FROM models m JOIN providers p ON p.id = m.provider_id
       ${where}
       ORDER BY p.name, m.original_name`
    )
    .all();
}

function setAlias(modelId, alias) {
  const clean = alias ? String(alias).trim() : null;
  if (clean && !/^[a-zA-Z0-9._:\/-]+$/.test(clean)) {
    throw new Error('Takma ad sadece harf, rakam ve _ . : / - karakterlerini içerebilir');
  }
  if (clean) {
    const clash = db.prepare('SELECT id FROM models WHERE alias = ? AND id != ?').get(clean, modelId);
    if (clash) throw new Error(`"${clean}" takma adı başka bir modele atanmış`);
  }
  db.prepare(`UPDATE models SET alias = ?, updated_at = datetime('now') WHERE id = ?`).run(clean, modelId);
  return clean;
}

function setActive(modelId, active) {
  db.prepare(`UPDATE models SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(active ? 1 : 0, modelId);
}

function setPricing(modelId, pricing = {}) {
  const row = db.prepare('SELECT pricing FROM models WHERE id = ?').get(modelId);
  if (!row) return null;

  let existing = {};
  try { existing = JSON.parse(row.pricing || '{}') || {}; } catch { /* bozuk fiyatı sıfırdan düzelt */ }

  const parsePrice = (value, label) => {
    if (value === '' || value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} fiyatı sıfır veya pozitif olmalı`);
    return n;
  };

  const input = parsePrice(pricing.input, 'Giriş');
  const output = parsePrice(pricing.output, 'Çıkış');
  const next = { ...existing };
  if (input == null) delete next.input;
  else next.input = input;
  if (output == null) delete next.output;
  else next.output = output;

  db.prepare('UPDATE models SET pricing = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(JSON.stringify(next), modelId);
  return next;
}

function allCategories() {
  const rows = db
    .prepare(
      `SELECT categories FROM models WHERE is_active = 1 AND categories != '[]'`
    )
    .all();
  const counts = new Map();
  for (const r of rows) {
    let list = [];
    try { list = JSON.parse(r.categories); } catch { /* bozuk veri atla */ }
    for (const c of list) counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * İstekte gelen model adını resolve eder.
 * @returns {{models: Array, ambiguous: boolean}} eşleşen model satırları
 */
function resolve(modelName) {
  if (!modelName) return { models: [], ambiguous: false };
  const name = String(modelName).trim();
  const rows = allModels();

  // 1) "provider/model" biçimi ÖNCE denenir.
  //    Bazı sağlayıcılar (crossmodel, edenai vb.) model kimliklerini kendileri
  //    namespace'ler ("openai/gpt-4o"). Tam ad eşleşmesi önce yapılırsa yanlış
  //    sağlayıcı seçilir ve kullanıcı "openai/gpt-4o" yazınca 409 alır.
  if (name.includes('/')) {
    const idx = name.indexOf('/');
    const pSlug = name.slice(0, idx);
    const mName = name.slice(idx + 1);
    const scoped = rows.filter(
      (m) => m.provider_slug === pSlug && (m.original_name === mName || m.alias === mName)
    );
    if (scoped.length) return { models: scoped, ambiguous: scoped.length > 1 };
  }

  // 2) Tam alias
  const byAlias = rows.filter((m) => m.alias === name);
  if (byAlias.length) return { models: byAlias, ambiguous: byAlias.length > 1 };

  // 3) Tam orijinal ad
  const byOriginal = rows.filter((m) => m.original_name === name);
  if (byOriginal.length) return { models: byOriginal, ambiguous: byOriginal.length > 1 };

  // 4) Büyük/küçük harf duyarsız orijinal ad
  const lower = name.toLowerCase();
  const ci = rows.filter((m) => m.original_name.toLowerCase() === lower);
  if (ci.length) return { models: ci, ambiguous: ci.length > 1 };

  // 5) Sağlayıcısı etkin olmayanları ele
  const usable = rows.filter((m) => m.provider_active);
  if (usable.length !== rows.length) {
    const u = usable.filter((m) => m.alias === name || m.original_name === name);
    if (u.length) return { models: u, ambiguous: u.length > 1 };
  }

  return { models: [], ambiguous: false };
}

/** API anahtarının erişebildiği modelleri filtreler */
function applyScope(models, scope) {
  if (!scope || scope === '*') return models;
  let allowed;
  try { allowed = JSON.parse(scope); } catch { return models; }
  if (!Array.isArray(allowed) || allowed.length === 0) return models;

  return models.filter((m) => {
    const ids = [m.original_name, m.alias, `${m.provider_slug}/${m.original_name}`].filter(Boolean);
    return allowed.some((a) => ids.includes(a));
  });
}

module.exports = { allModels, setAlias, setActive, setPricing, allCategories, resolve, applyScope };
