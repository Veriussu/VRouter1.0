const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const { inferCategory, inferCapabilities, normalizeCost } = require('./categories');
const { decrypt } = require('../crypto');

const uid = () => crypto.randomUUID();

/** models.dev verisini çeker */
async function fetchCatalog() {
  const res = await fetch(config.MODELS_DEV_URL, {
    headers: { 'user-agent': 'VRouter/0.1' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`models.dev ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * models.dev'de `api` alanı bulunmayan sağlayıcılar (çoğunlukla SDK ile
 * çağrılanlar) atlanırdı. Ancak OpenAI, Anthropic, Google gibi büyük
 * sağlayıcıların REST uçları iyi bilindiğinden burada tanımlanır.
 * Kullanıcı panelden base_url'u güncelleyebilir.
 */
const FALLBACK_APIS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  cerebras: 'https://api.cerebras.ai/v1',
  cohere: 'https://api.cohere.com/v2',
  perplexity: 'https://api.perplexity.ai',
  togetherai: 'https://api.together.xyz/v1',
  venice: 'https://api.venice.ai/api/v1',
  aihubmix: 'https://aihubmix.com/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  v0: 'https://v0.dev/v1',
  azure: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
  'azure-cognitive-services': 'https://YOUR-RESOURCE.cognitiveservices.azure.com/openai/v1',
  'cloudflare-ai-gateway': 'https://gateway.ai.cloudflare.com/v1',
  'google-vertex': 'https://LOCATION-aiplatform.googleapis.com/v1/projects/PROJECT/locations/LOCATION/publishers/google',
  'google-vertex-anthropic': 'https://LOCATION-aiplatform.googleapis.com/v1/projects/PROJECT/locations/LOCATION/publishers/anthropic',
  'amazon-bedrock': 'https://bedrock-runtime.REGION.amazonaws.com',
  watsonx: 'https://REGION.ml.cloud.ibm.com/ml/v1',
  gitlab: 'https://gitlab.com/api/v4',
  'sap-ai-core': 'https://YOUR-SERVICE.authentication.sap.hana.ondemand.com',
  'salad-cloud': 'https://api.salad.cloud/api/v1',
  qvac: 'https://api.qvac.ai/v1',
};

/** models.dev'de `api` alanı olmayan sağlayıcılar atlanır; env tabanlı SDK'lar
 *  doğrudan çağrılamaz (AWS, Vertex vb.) */
function skipProvider(p) {
  if (p.api) return false;
  return !FALLBACK_APIS[p.id];
}

/**
 * models.dev paketini veritabanına yazar.
 * - API alanı olmayan ve bilinen taban URL'si bulunmayan sağlayıcılar atlanır
 * - Mevcut kullanıcı alias'ları korunur
 */
async function syncFromModelsDev() {
  const catalog = await fetchCatalog();
  const providers = Object.values(catalog);

  const upsertProvider = db.prepare(`
    INSERT INTO providers (id, name, slug, base_url, api_format, logo_url, docs_url, metadata, updated_at)
    VALUES (@id, @name, @slug, @base_url, @api_format, @logo_url, @docs_url, @metadata, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      api_format = excluded.api_format,
      logo_url = excluded.logo_url,
      docs_url = excluded.docs_url,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `);

  const upsertModel = db.prepare(`
    INSERT INTO models (id, provider_id, original_name, display_name, categories, capabilities,
                        description, context_length, max_output, modality_in, modality_out,
                        pricing, release_date, is_available, last_synced_at, updated_at)
    VALUES (@id, @provider_id, @original_name, @display_name, @categories, @capabilities,
            @description, @context_length, @max_output, @modality_in, @modality_out,
            @pricing, @release_date, 1, datetime('now'), datetime('now'))
    ON CONFLICT(provider_id, original_name) DO UPDATE SET
      display_name = excluded.display_name,
      categories    = excluded.categories,
      capabilities  = excluded.capabilities,
      description   = excluded.description,
      context_length= excluded.context_length,
      max_output    = excluded.max_output,
      modality_in   = excluded.modality_in,
      modality_out  = excluded.modality_out,
      pricing       = excluded.pricing,
      release_date  = excluded.release_date,
      is_available  = 1,
      last_synced_at = datetime('now'),
      updated_at    = datetime('now')
  `);

  // alias'ları ve kullanıcı değişikliklerini korumak için mevcut modelleri belleğe al
  const existingModels = new Set(
    db.prepare("SELECT provider_id || '::' || original_name AS k FROM models").all().map((r) => r.k)
  );
  const seenModels = new Set();
  const seenProviders = new Set();

  let providerCount = 0;
  let modelCount = 0;

  const tx = db.transaction(() => {
    for (const p of providers) {
      if (skipProvider(p)) continue;

      const slug = String(p.id || p.name).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      const apiFormat = detectFormat(p);
      upsertProvider.run({
        id: slug,
        name: p.name || slug,
        slug,
        base_url: p.api || FALLBACK_APIS[slug],
        api_format: apiFormat,
        logo_url: `https://models.dev/logos/${p.id}.svg`,
        docs_url: p.doc || null,
        metadata: JSON.stringify({
          npm: p.npm || null,
          env: p.env || [],
          placeholder_url: !p.api && !!FALLBACK_APIS[slug],
        }),
      });
      seenProviders.add(slug);
      providerCount++;

      for (const [modelId, m] of Object.entries(p.models || {})) {
        const key = `${slug}::${modelId}`;
        if (seenModels.has(key)) continue;
        seenModels.add(key);

        const modalities = m.modalities || {};
        const categories = inferCategory(modelId, m.name, modalities, m);
        const capabilities = inferCapabilities(m, modalities);

        upsertModel.run({
          id: uid(),
          provider_id: slug,
          original_name: modelId,
          display_name: m.name || modelId,
          categories: JSON.stringify(categories),
          capabilities: JSON.stringify(capabilities),
          description: m.description || null,
          context_length: m.limit?.context ?? null,
          max_output: m.limit?.output ?? null,
          modality_in: JSON.stringify(modalities.input || []),
          modality_out: JSON.stringify(modalities.output || []),
          pricing: JSON.stringify(normalizeCost(m.cost)),
          release_date: m.release_date || m.last_updated || null,
        });
        modelCount++;
      }
    }

    // models.dev'de artık olmayan modelleri pasif işaretle (alias silinmesin)
    for (const row of existingModels) {
      if (seenModels.has(row)) continue;
      const sep = row.indexOf('::');
      const providerId = row.slice(0, sep);
      const name = row.slice(sep + 2);
      if (!seenProviders.has(providerId)) continue;
      db.prepare(
        `UPDATE models SET is_available = 0, updated_at = datetime('now')
         WHERE provider_id = ? AND original_name = ?`
      ).run(providerId, name);
    }
  });

  tx();

  return { providers: providerCount, models: modelCount, at: new Date().toISOString() };
}

/**
 * API anahtarı eklenen sağlayıcının kendi /models listesini keşfeder.
 * OpenAI uyumlu sağlayıcılar için çalışır; desteklemeyen sağlayıcılarda
 * anahtar ekleme işlemini başarısız etmeden açıklayıcı sonuç döndürür.
 */
async function syncProviderModels(provider) {
  if (!provider?.base_url) return { count: 0, skipped: true, error: 'Sağlayıcının base_url değeri boş' };

  const keyRow = db.prepare(
    `SELECT key_encrypted FROM provider_api_keys
     WHERE provider_id = ? AND status = 'active'
       AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
     ORDER BY priority ASC, created_at ASC LIMIT 1`
  ).get(provider.id);
  const key = keyRow ? decrypt(keyRow.key_encrypted) : null;
  if (!key) return { count: 0, skipped: true, error: 'Aktif sağlayıcı anahtarı çözülemedi' };

  const base = String(provider.base_url).replace(/\/+$/, '');
  const headers = provider.api_format === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` };

  let response;
  try {
    response = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(Math.min(config.REQUEST_TIMEOUT_MS, 60000)),
    });
  } catch (err) {
    return { count: 0, skipped: false, error: `Model endpointine ulaşılamadı: ${err.message}` };
  }

  if (!response.ok) {
    return { count: 0, skipped: false, error: `Model endpointi ${response.status} döndürdü` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { count: 0, skipped: false, error: 'Model endpointi geçersiz JSON döndürdü' };
  }

  const list = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(list)) return { count: 0, skipped: false, error: 'Yanıtta model listesi bulunamadı' };

  const upsert = db.prepare(`
    INSERT INTO models (id, provider_id, original_name, display_name, categories, capabilities,
                        description, context_length, max_output, modality_in, modality_out,
                        pricing, release_date, is_active, is_available, last_synced_at, updated_at)
    VALUES (@id, @provider_id, @original_name, @display_name, @categories, @capabilities,
            @description, @context_length, @max_output, @modality_in, @modality_out,
            @pricing, @release_date, 0, 1, datetime('now'), datetime('now'))
    ON CONFLICT(provider_id, original_name) DO UPDATE SET
      display_name = excluded.display_name,
      description = excluded.description,
      context_length = excluded.context_length,
      max_output = excluded.max_output,
      categories = excluded.categories,
      capabilities = excluded.capabilities,
      modality_in = excluded.modality_in,
      modality_out = excluded.modality_out,
      pricing = excluded.pricing,
      release_date = excluded.release_date,
      is_available = 1,
      last_synced_at = datetime('now'),
      updated_at = datetime('now')
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const item of list) {
      const originalName = String(item?.id || item?.name || '').trim();
      if (!originalName) continue;
      const displayName = item.name || originalName;
      const categories = inferCategory(originalName, displayName, item.modalities || {}, item);
      const capabilities = inferCapabilities(item, item.modalities || {});
      upsert.run({
        id: crypto.randomUUID(),
        provider_id: provider.id,
        original_name: originalName,
        display_name: displayName,
        categories: JSON.stringify(categories),
        capabilities: JSON.stringify(capabilities),
        description: item.description || null,
        context_length: item.context_length ?? item.limit?.context ?? null,
        max_output: item.max_output ?? item.limit?.output ?? null,
        modality_in: JSON.stringify(item.modalities?.input || []),
        modality_out: JSON.stringify(item.modalities?.output || []),
        pricing: JSON.stringify(normalizeCost(item.pricing || item.cost || {})),
        release_date: item.created ? new Date(item.created * 1000).toISOString() : null,
      });
      count++;
    }
  });
  tx();

  return { count, skipped: false };
}

function detectFormat(p) {
  const npm = String(p.npm || '').toLowerCase();
  const id = String(p.id || '').toLowerCase();
  if (npm.includes('anthropic') || id.includes('anthropic') || id.includes('minimax')) return 'anthropic';
  // Google, FALLBACK_APIS'te OpenAI-uyumlu uç olarak tanımlandığı için
  // bearer token kullanan 'openai' formatında bırakıldı.
  return 'openai';
}

module.exports = { syncFromModelsDev, syncProviderModels, fetchCatalog };
