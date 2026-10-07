const express = require('express');
const router = express.Router();

const providerSvc = require('../services/providers');
const modelSvc = require('../services/models');
const apiKeys = require('../services/apiKeys');
const logger = require('../services/logger');
const rotator = require('../services/keyRotator');
const syncSvc = require('../services/sync');
const { db, getSetting, setSetting } = require('../db');

const parseJson = (s, f = {}) => { try { return JSON.parse(s); } catch { return f; } };

/* --------------------------- dashboard --------------------------- */

router.get('/stats', (req, res) => {
  const s = logger.stats({ hours: req.query.hours || 24 });
  const counts = {
    providers: db.prepare('SELECT COUNT(*) n FROM providers').get().n,
    active_providers: db.prepare('SELECT COUNT(*) n FROM providers WHERE is_active = 1').get().n,
    models: db.prepare('SELECT COUNT(*) n FROM models WHERE is_active = 1').get().n,
    available_models: db.prepare('SELECT COUNT(*) n FROM models WHERE is_active = 1 AND is_available = 1').get().n,
    catalog_models: db.prepare('SELECT COUNT(*) n FROM models WHERE is_available = 1').get().n,
    api_keys: db.prepare('SELECT COUNT(*) n FROM api_keys').get().n,
    provider_keys: db.prepare('SELECT COUNT(*) n FROM provider_api_keys').get().n,
    healthy_keys: db.prepare(`SELECT COUNT(*) n FROM provider_api_keys WHERE status = 'active'`).get().n,
  };
  res.json({ counts, ...s, categories: modelSvc.allCategories() });
});

/* --------------------------- providers --------------------------- */

router.get('/providers', (req, res) => {
  const providers = providerSvc.listProviders();
  const enriched = providers.map((p) => ({
    ...p,
    metadata: parseJson(p.metadata, {}),
    key_state: rotator.providerKeyState(p.id),
  }));
  res.json({ data: enriched });
});

router.post('/providers', (req, res) => {
  const { name, slug, base_url, api_format, docs_url } = req.body || {};
  if (!name || !base_url) return res.status(400).json({ error: 'name ve base_url zorunlu' });
  try {
    res.json({ data: providerSvc.createProvider({ name, slug, base_url, api_format, docs_url }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/providers/:id', (req, res) => {
  const updated = providerSvc.updateProvider(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Sağlayıcı bulunamadı' });
  res.json({ data: updated });
});

router.delete('/providers/:id', (req, res) => {
  const r = providerSvc.deleteProvider(req.params.id);
  if (!r.ok) return res.status(400).json({ error: r.reason });
  res.json({ ok: true, name: r.name, keys: r.keys });
});

/** Silinen sağlayıcıyı geri getirir. */
router.post('/providers/:id/restore', (req, res) => {
  const r = providerSvc.restoreProvider(req.params.id);
  if (!r.ok) return res.status(400).json({ error: r.reason });
  res.json({ ok: true, name: r.name, keys: r.keys });
});

/** Sağlayıcının kendi model listesini manuel olarak yeniler. */
router.post('/providers/:id/sync-models', async (req, res) => {
  const provider = providerSvc.getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Sağlayıcı bulunamadı' });
  const result = await syncSvc.syncProviderModels(provider);
  if (result.error) return res.status(502).json({ error: result.error, models_synced: result });
  res.json({ data: result });
});

/* ------------------------ provider api keys ------------------------ */

router.get('/providers/:id/keys', (req, res) => {
  const p = providerSvc.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: 'Sağlayıcı bulunamadı' });
  res.json({ data: providerSvc.listKeys(p.id) });
});

router.post('/providers/:id/keys', async (req, res) => {
  const { key, key_name, priority } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key zorunlu' });
  try {
    const data = providerSvc.addKey(req.params.id, { key, key_name, priority: priority ?? 0 });
    const provider = providerSvc.getProvider(req.params.id);
    const models_synced = await syncSvc.syncProviderModels(provider);
    if (models_synced.error) console.warn(`[models] ${provider.slug}: ${models_synced.error}`);
    res.json({ data, models_synced });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete('/keys/:keyId', (req, res) => {
  res.json({ ok: providerSvc.deleteKey(req.params.keyId) });
});

router.patch('/keys/:keyId', (req, res) => {
  const { status, priority, key_name } = req.body || {};
  if (status) providerSvc.setKeyStatus(req.params.keyId, status);
  if (priority != null) db.prepare('UPDATE provider_api_keys SET priority = ? WHERE id = ?').run(priority, req.params.keyId);
  if (key_name) db.prepare('UPDATE provider_api_keys SET key_name = ? WHERE id = ?').run(key_name, req.params.keyId);
  res.json({ ok: true });
});

router.get('/keys', (req, res) => res.json({ data: providerSvc.allKeys() }));

/* ---------------------------- models ---------------------------- */

/**
 * Kategori listesi. /models/:id ile çakışmaması için
 * /models'tan ÖNCE tanımlanmalı.
 */
router.get('/models/categories', (req, res) => {
  const rows = modelSvc.allModels();
  const counts = new Map();
  for (const m of rows) {
    for (const c of parseJson(m.categories, [])) {
      if (!c) continue;
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  res.json({
    data: [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
  });
});

router.get('/models', (req, res) => {
  const { category, provider, search, limit } = req.query;
  let rows = modelSvc.allModels();

  if (category) {
    const wanted = String(category).split(',').map((s) => s.toLowerCase());
    rows = rows.filter((m) => (parseJson(m.categories, []).map((c) => c.toLowerCase())).some((c) => wanted.includes(c)));
  }
  if (provider) rows = rows.filter((m) => m.provider_slug === provider);
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((m) =>
      [m.original_name, m.alias, m.display_name].filter(Boolean).some((s) => s.toLowerCase().includes(q))
    );
  }

  rows = rows
    .map((m) => ({
      ...m,
      categories: parseJson(m.categories, []),
      capabilities: parseJson(m.capabilities, []),
      pricing: parseJson(m.pricing, {}),
    }))
    .sort((a, b) => (a.provider_slug + a.original_name).localeCompare(b.provider_slug + b.original_name));

  const total = rows.length;
  const n = parseInt(limit || '500', 10);
  res.json({ data: rows.slice(0, n), total });
});

// Panelde eklenebilecek modeller: yalnızca aktif anahtarı bulunan
// sağlayıcıların katalogdaki modelleri.
router.get('/models/available', (req, res) => {
  const { provider, search, limit } = req.query;
  let rows = modelSvc.allModels({ activeOnly: false, availableOnly: true, withActiveKey: true });

  if (provider) rows = rows.filter((m) => m.provider_slug === provider);
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((m) =>
      [m.original_name, m.alias, m.display_name, m.provider_name].filter(Boolean).some((s) => s.toLowerCase().includes(q))
    );
  }

  rows = rows.map((m) => ({
    ...m,
    categories: parseJson(m.categories, []),
    capabilities: parseJson(m.capabilities, []),
    pricing: parseJson(m.pricing, {}),
  }));

  const total = rows.length;
  const n = Math.max(0, Math.min(parseInt(limit || '500', 10), 4000));
  res.json({ data: rows.slice(0, n), total });
});

router.patch('/models/:id', (req, res) => {
  const { alias, is_active, pricing } = req.body || {};
  try {
    if (alias !== undefined) modelSvc.setAlias(req.params.id, alias);
    if (is_active !== undefined) modelSvc.setActive(req.params.id, is_active);
    if (pricing !== undefined) modelSvc.setPricing(req.params.id, pricing);
    const row = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Model bulunamadı' });
    res.json({ data: {
      ...row,
      categories: parseJson(row.categories, []),
      capabilities: parseJson(row.capabilities, []),
      pricing: parseJson(row.pricing, {}),
    } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------- api keys -------------------------- */

router.get('/api-keys', (req, res) => res.json({ data: apiKeys.list() }));

router.post('/api-keys', (req, res) => {
  const { name, description, models: scope, rate_limit, daily_token_limit, daily_request_limit, valid_from, valid_until } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name zorunlu' });

  // Model kapsamını doğrula
  let modelScope = '*';
  if (Array.isArray(scope) && scope.length) {
    for (const s of scope) {
      const { models } = modelSvc.resolve(s);
      if (!models.length) return res.status(400).json({ error: `Geçersiz model: ${s}` });
    }
    modelScope = JSON.stringify(scope);
  }

  const created = apiKeys.create({
    name, description, model_scope: modelScope,
    rate_limit: rate_limit ? parseInt(rate_limit, 10) : null,
    daily_token_limit: daily_token_limit ? parseInt(daily_token_limit, 10) : null,
    daily_request_limit: daily_request_limit ? parseInt(daily_request_limit, 10) : null,
    valid_from: valid_from || null,
    valid_until: valid_until || null,
  });
  res.json({ data: created });
});

router.patch('/api-keys/:id', (req, res) => {
  const patch = { ...req.body };
  if (Array.isArray(patch.models)) {
    for (const s of patch.models) {
      const { models } = modelSvc.resolve(s);
      if (!models.length) return res.status(400).json({ error: `Geçersiz model: ${s}` });
    }
    patch.model_scope = JSON.stringify(patch.models);
    delete patch.models;
  }
  const updated = apiKeys.update(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'API anahtarı bulunamadı' });
  res.json({ data: updated });
});

router.delete('/api-keys/:id', (req, res) => res.json({ ok: apiKeys.remove(req.params.id) }));

/* ---------------------------- logs ---------------------------- */

router.get('/logs', (req, res) => {
  const result = logger.query({
    limit: parseInt(req.query.limit || '50', 10),
    offset: parseInt(req.query.offset || '0', 10),
    apiKeyId: req.query.api_key_id,
    providerId: req.query.provider_id,
    modelId: req.query.model_id,
    status: req.query.status,
    search: req.query.search,
    from: req.query.from,
    to: req.query.to,
  });
  res.json(result);
});

router.delete('/logs', (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  res.json({ deleted: logger.purge(days) });
});

/* ---------------------------- sync ---------------------------- */

router.get('/sync-status', (req, res) => {
  res.json({
    last_sync: getSetting('last_sync'),
    last_error: getSetting('last_sync_error'),
    source: getSetting('sync_source'),
  });
});

router.post('/sync', async (req, res) => {
  try {
    const result = await syncSvc.syncFromModelsDev();
    setSetting('last_sync', new Date().toISOString());
    setSetting('last_sync_error', '');
    res.json({ data: result });
  } catch (err) {
    setSetting('last_sync_error', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------ maintenance ------------------------ */

router.post('/maintenance/revive-keys', (req, res) => {
  const n = rotator.reviveCooldowns();
  res.json({ revived: n });
});

module.exports = router;
