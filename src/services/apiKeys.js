const crypto = require('crypto');
const { db } = require('../db');
const { hashKey } = require('../crypto');

const uid = () => crypto.randomUUID();

function generateKey() {
  const raw = `vr_${crypto.randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashKey(raw), prefix: raw.slice(0, 11) };
}

function create({
  name,
  description,
  model_scope = '*',
  rate_limit = null,
  daily_token_limit = null,
  daily_request_limit = null,
  valid_from = null,
  valid_until = null,
}) {
  const { raw, hash, prefix } = generateKey();
  const id = uid();
  db.prepare(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, description, model_scope,
                           rate_limit, daily_token_limit, daily_request_limit, valid_from, valid_until)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, name, hash, prefix, description || null, model_scope, rate_limit, daily_token_limit, daily_request_limit, valid_from, valid_until);
  return { id, key: raw, record: get(id) };
}

function get(id) {
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
}

function list() {
  return db
    .prepare(
      `SELECT k.*,
              (SELECT COUNT(*) FROM request_logs l WHERE l.api_key_id = k.id) AS total_requests,
              (SELECT COALESCE(SUM(l.total_tokens),0) FROM request_logs l WHERE l.api_key_id = k.id) AS total_tokens,
              (SELECT COALESCE(SUM(l.cost),0) FROM request_logs l WHERE l.api_key_id = k.id) AS total_cost,
              (SELECT COUNT(*) FROM request_logs l WHERE l.api_key_id = k.id AND l.created_at >= datetime('now','-24 hours')) AS requests_24h,
              (SELECT COALESCE(SUM(l.total_tokens),0) FROM request_logs l WHERE l.api_key_id = k.id AND l.created_at >= datetime('now','-24 hours')) AS tokens_24h
       FROM api_keys k ORDER BY k.created_at DESC`
    )
    .all();
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE api_keys SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       model_scope = COALESCE(?, model_scope),
       rate_limit = COALESCE(?, rate_limit),
       daily_token_limit = COALESCE(?, daily_token_limit),
       daily_request_limit = COALESCE(?, daily_request_limit),
       valid_from = COALESCE(?, valid_from),
       valid_until = COALESCE(?, valid_until),
       is_active = COALESCE(?, is_active)
     WHERE id = ?`
  ).run(
    patch.name ?? null,
    patch.description ?? null,
    patch.model_scope ?? null,
    patch.rate_limit ?? null,
    patch.daily_token_limit ?? null,
    patch.daily_request_limit ?? null,
    patch.valid_from ?? null,
    patch.valid_until ?? null,
    patch.is_active === undefined ? null : patch.is_active ? 1 : 0,
    id
  );
  return get(id);
}

function remove(id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
}

function touch(id) {
  db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(id);
}

/** Gelen Authorization başlığından anahtarı doğrular ve limitleri kontrol eder */
function authenticate(presentedKey) {
  if (!presentedKey) return { ok: false, error: 'missing_key' };

  const rec = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(presentedKey));
  if (!rec) return { ok: false, error: 'invalid_key' };
  if (!rec.is_active) return { ok: false, error: 'inactive_key' };

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (rec.valid_from && now < rec.valid_from) return { ok: false, error: 'not_yet_valid', record: rec };
  if (rec.valid_until && now > rec.valid_until) return { ok: false, error: 'expired', record: rec };

  // Dakikalık hız limiti
  if (rec.rate_limit) {
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM request_logs
         WHERE api_key_id = ? AND created_at >= datetime('now','-1 minute')`
      )
      .get(rec.id).n;
    if (n >= rec.rate_limit) {
      return { ok: false, error: 'rate_limited', record: rec, detail: `dakikada ${rec.rate_limit} istek limiti` };
    }
  }

  // Günlük limitler
  if (rec.daily_request_limit) {
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM request_logs
         WHERE api_key_id = ? AND created_at >= datetime('now','-24 hours')`
      )
      .get(rec.id).n;
    if (n >= rec.daily_request_limit) {
      return { ok: false, error: 'daily_request_limit', record: rec, detail: `24 saatte ${rec.daily_request_limit} istek limiti` };
    }
  }

  if (rec.daily_token_limit) {
    const t = db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) AS t FROM request_logs
         WHERE api_key_id = ? AND created_at >= datetime('now','-24 hours')`
      )
      .get(rec.id).t;
    if (t >= rec.daily_token_limit) {
      return { ok: false, error: 'daily_token_limit', record: rec, detail: `24 saatte ${rec.daily_token_limit} token limiti` };
    }
  }

  return { ok: true, record: rec };
}

module.exports = { create, get, list, update, remove, authenticate, touch, generateKey };
