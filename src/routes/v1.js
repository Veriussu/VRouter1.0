const express = require('express');
const router = express.Router();

const apiKeys = require('../services/apiKeys');
const modelSvc = require('../services/models');
const providerSvc = require('../services/providers');
const proxySvc = require('../services/proxy');
const compressor = require('../services/compressor');
const logger = require('../services/logger');
const rotator = require('../services/keyRotator');
const config = require('../config');

/* --------------------------- yardımcılar --------------------------- */

function extractKey(req) {
  const h = req.get('authorization');
  if (h && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return req.get('x-api-key') || req.query.key || null;
}

function parseJson(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/** /v1/models çıktısı için model satırını OpenAI biçimine çevir */
function toModelObject(m) {
  const pricing = parseJson(m.pricing, {}) || {};
  const categories = parseJson(m.categories, []) || [];
  const capabilities = parseJson(m.capabilities, []) || [];
  return {
    id: m.alias || m.original_name,
    vr_id: m.id,
    object: 'model',
    created: Math.floor(new Date(m.created_at || Date.now()).getTime() / 1000),
    owned_by: m.provider_slug,
    display_name: m.display_name,
    original_name: m.alias ? m.original_name : undefined,
    categories,
    capabilities,
    context_length: m.context_length,
    max_output_tokens: m.max_output,
    modalities: { input: parseJson(m.modality_in, []), output: parseJson(m.modality_out, []) },
    pricing: {
      input: pricing.input ?? null,
      output: pricing.output ?? null,
      currency: 'USD',
      unit: 'per_1M_tokens',
    },
    release_date: m.release_date,
  };
}

const ERRORS = {
  missing_key:      { status: 401, message: 'API anahtarı gerekli. "Authorization: Bearer <key>" başlığını kullanın.' },
  invalid_key:      { status: 401, message: 'Geçersiz API anahtarı.' },
  inactive_key:     { status: 403, message: 'Bu API anahtarı devre dışı bırakılmış.' },
  not_yet_valid:    { status: 403, message: 'Bu API anahtarının kullanım başlangıcı henüz gelmedi.' },
  expired:          { status: 403, message: 'Bu API anahtarının süresi dolmuş.' },
  rate_limited:     { status: 429, message: 'Hız limiti aşıldı.' },
  daily_request_limit: { status: 429, message: 'Günlük istek limiti aşıldı.' },
  daily_token_limit:   { status: 429, message: 'Günlük token limiti aşıldı.' },
};

function authMiddleware(req, res, next) {
  const result = apiKeys.authenticate(extractKey(req));
  if (!result.ok) {
    const e = ERRORS[result.error] || { status: 401, message: 'Yetkilendirme hatası' };
    return res.status(e.status).json({
      error: { type: 'invalid_request_error', code: result.error, message: result.detail ? `${e.message} (${result.detail})` : e.message },
    });
  }
  req.apiKey = result.record;
  next();
}

/* ----------------------------- /v1/models ----------------------------- */

router.get('/models', authMiddleware, (req, res) => {
  const { category, provider, capability, search } = req.query;
  let rows = modelSvc.allModels();
  rows = modelSvc.applyScope(rows, req.apiKey.model_scope);

  if (category) {
    const wanted = String(category).split(',').map((s) => s.trim().toLowerCase());
    rows = rows.filter((m) => {
      const cats = (parseJson(m.categories, []) || []).map((c) => c.toLowerCase());
      return wanted.some((w) => cats.includes(w));
    });
  }
  if (provider) rows = rows.filter((m) => m.provider_slug === provider);
  if (capability) {
    rows = rows.filter((m) => (parseJson(m.capabilities, []) || []).includes(capability));
  }
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((m) =>
      [m.original_name, m.alias, m.display_name, m.provider_name].filter(Boolean).some((s) => s.toLowerCase().includes(q))
    );
  }

  res.json({ object: 'list', data: rows.map(toModelObject) });
});

/** Kategori listesi */
router.get('/models/categories', authMiddleware, (req, res) => {
  const rows = modelSvc.applyScope(modelSvc.allModels(), req.apiKey.model_scope);
  const counts = new Map();
  for (const m of rows) {
    for (const c of parseJson(m.categories, []) || []) counts.set(c, (counts.get(c) || 0) + 1);
  }
  res.json({
    object: 'list',
    data: [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
  });
});

/** Tek model detayı */
router.get('/models/:id', authMiddleware, (req, res) => {
  const { models } = modelSvc.resolve(req.params.id);
  const scoped = modelSvc.applyScope(models, req.apiKey.model_scope);
  if (!scoped.length) return res.status(404).json({ error: { message: 'Model bulunamadı', type: 'invalid_request_error' } });
  res.json({ object: 'model', data: scoped.map(toModelObject) });
});

/* --------------------------- chat/completions --------------------------- */

/** Ana yönlendirme: model çöz -> anahtar döngüsü -> sağlayıcı */
async function handleCompletion(req, res, endpoint) {
  const startedAt = Date.now();
  const body = { ...req.body };
  const requestedModel = body.model;
  const isStream = !!body.stream;

  // 1) Model çözümleme
  const { models: candidates, ambiguous } = modelSvc.resolve(requestedModel);
  if (candidates.length === 0) {
    return res.status(404).json({
      error: { type: 'invalid_request_error', message: `Model bulunamadı: ${requestedModel}` },
    });
  }
  const scoped = modelSvc.applyScope(candidates, req.apiKey.model_scope);
  if (scoped.length === 0) {
    return res.status(403).json({
      error: {
        type: 'permission_error',
        message: `Bu API anahtarı "${requestedModel}" modeline erişemez`,
      },
    });
  }
  if (ambiguous) {
    return res.status(409).json({
      error: {
        type: 'invalid_request_error',
        code: 'ambiguous_model',
        message: `"${requestedModel}" birden fazla sağlayıcıda bulundu. "saglayici/model" biçiminde belirtin.`,
        candidates: scoped.map((m) => m.provider_slug),
      },
    });
  }

  // 2) Token sıkıştırma
  let comp = { body, savedTokens: 0, applied: false, notes: [] };
  if (endpoint === 'chat' && Array.isArray(body.messages)) {
    comp = compressor.compress(body);
  }

  // 3) Her aday model için dene (sağlayıcı bazlı failover)
  const errors = [];
  let lastRes;

  for (const model of scoped) {
    const provider = providerSvc.getProvider(model.provider_slug);
    if (!provider || provider.is_deleted) {
      errors.push(`${model.provider_slug}: sağlayıcı silinmiş`);
      lastRes = new proxySvc.UpstreamError(`"${model.provider_slug}" sağlayıcısı silinmiş`, {
        status: 503, kind: 'server', retryable: true,
      });
      continue;
    }
    if (!provider.is_active) {
      errors.push(`${model.provider_slug}: sağlayıcı pasif`);
      lastRes = new proxySvc.UpstreamError(`"${model.provider_slug}" sağlayıcısı pasif durumda`, {
        status: 503, kind: 'server', retryable: true,
      });
      continue;
    }

    // Sağlayıcıda bu model için anahtar var mı?
    const state = rotator.providerKeyState(provider.id);
    if (!state || state.total === 0) {
      errors.push(`${provider.name}: API anahtarı yok`);
      // 429 döndür ki istemci "anahtar tanımlayın" mesajını alsın
      lastRes = new proxySvc.UpstreamError(
        `"${provider.name}" sağlayıcısı için API anahtarı tanımlanmamış`,
        { status: 429, kind: 'quota', retryable: true }
      );
      continue;
    }

    const payload = { ...comp.body, model: model.original_name };

    try {
      if (isStream) {
        const result = await proxySvc.dispatch({
          provider, endpoint, body: payload, stream: true, signal: req.signal,
        });

        res.status(200);
        res.set({
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders?.();

        // Akış bittiğinde kullanım bilgisi hazır olsun diye bekle
        await new Promise((resolve, reject) => {
          result.stream.on('error', reject);
          result.stream.on('end', resolve);
          result.stream.pipe(res);
        });

        const usage = result.getUsage();
        const cost = proxySvc.computeCost(model, usage.inputTokens, usage.outputTokens);
        logger.write({
          apiKeyId: req.apiKey.id, providerId: provider.id, providerKeyId: result.providerKeyId,
          modelId: model.id, requestedModel, endpoint, category: 'chat', stream: true,
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost,
          usageKnown: usage.known,
          latencyMs: Date.now() - startedAt, status: 'success', statusCode: result.status,
          compressed: comp.applied, savedTokens: comp.savedTokens, attempts: result.attempts,
          clientIp: req.ip, userAgent: req.get('user-agent'),
        });
        apiKeys.touch(req.apiKey.id);
        res.end();
        return;
      }

      const result = await proxySvc.dispatch({ provider, endpoint, body: payload, stream: false, signal: req.signal });
      const cost = proxySvc.computeCost(model, result.usage.inputTokens, result.usage.outputTokens);

      logger.write({
        apiKeyId: req.apiKey.id, providerId: provider.id, providerKeyId: result.providerKeyId,
        modelId: model.id, requestedModel, endpoint, category: 'chat', stream: false,
        inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cost,
        usageKnown: result.usage.known,
        latencyMs: Date.now() - startedAt, status: 'success', statusCode: result.status,
        compressed: comp.applied, savedTokens: comp.savedTokens, attempts: result.attempts,
        clientIp: req.ip, userAgent: req.get('user-agent'),
      });
      apiKeys.touch(req.apiKey.id);

      res.status(result.status).json(result.json);
      return;
    } catch (err) {
      lastRes = err;
      errors.push(`${provider.name}: ${err.message}`);
      console.warn(`[v1] ${provider.name} → ${err.message}`);
      // Anahtar hatası ise sıradaki sağlayıcıyı dene, istemci hatasıysa dur
      if (!err.retryable) break;
    }
  }

  logger.write({
    apiKeyId: req.apiKey.id, requestedModel, endpoint, category: 'chat',
    status: 'error', statusCode: lastRes?.status || 502,
    errorMessage: errors.join(' | '), latencyMs: Date.now() - startedAt,
    compressed: comp.applied, savedTokens: comp.savedTokens,
    clientIp: req.ip, userAgent: req.get('user-agent'),
  });

  res.status(lastRes?.status || 502).json({
    error: {
      type: lastRes?.kind === 'client' ? 'invalid_request_error' : 'api_error',
      message: lastRes?.message || 'Sağlayıcıya ulaşılamadı',
      details: errors,
    },
  });
}

router.post('/chat/completions', authMiddleware, (req, res) => handleCompletion(req, res, 'chat'));
router.post('/completions', authMiddleware, (req, res) => handleCompletion(req, res, 'completions'));

/* ------------------------------ embeddings ------------------------------ */

router.post('/embeddings', authMiddleware, async (req, res) => {
  const { models, ambiguous } = modelSvc.resolve(req.body.model);
  const scoped = modelSvc.applyScope(models, req.apiKey.model_scope);
  if (!scoped.length) return res.status(404).json({ error: { message: 'Embedding modeli bulunamadı', type: 'invalid_request_error' } });
  if (ambiguous) return res.status(409).json({ error: { message: 'Model belirsiz, "saglayici/model" kullanın', code: 'ambiguous_model' } });

  const model = scoped[0];
  const provider = providerSvc.getProvider(model.provider_slug);
  try {
    const result = await proxySvc.dispatch({
      provider, endpoint: 'embeddings',
      body: { ...req.body, model: model.original_name },
      signal: req.signal,
    });
    const cost = proxySvc.computeCost(model, result.usage.inputTokens, result.usage.outputTokens);
    logger.write({
      apiKeyId: req.apiKey.id, providerId: provider.id, providerKeyId: result.providerKeyId,
      modelId: model.id, requestedModel: req.body.model, endpoint: 'embeddings', category: 'embedding',
      inputTokens: result.usage.inputTokens, status: 'success', statusCode: result.status,
      outputTokens: result.usage.outputTokens, usageKnown: result.usage.known, cost,
      clientIp: req.ip, userAgent: req.get('user-agent'),
    });
    apiKeys.touch(req.apiKey.id);
    res.json(result.json);
  } catch (err) {
    logger.write({
      apiKeyId: req.apiKey.id, requestedModel: req.body.model, endpoint: 'embeddings',
      category: 'embedding', status: 'error', statusCode: err.status, errorMessage: err.message,
      clientIp: req.ip, userAgent: req.get('user-agent'),
    });
    res.status(err.status || 502).json({ error: { type: 'api_error', message: err.message } });
  }
});

/* ------------------------------ images ------------------------------ */

router.post('/images/generations', authMiddleware, async (req, res) => {
  const { models } = modelSvc.resolve(req.body.model);
  const scoped = modelSvc.applyScope(models, req.apiKey.model_scope);
  if (!scoped.length) return res.status(404).json({ error: { message: 'Görsel modeli bulunamadı', type: 'invalid_request_error' } });

  const model = scoped[0];
  const provider = providerSvc.getProvider(model.provider_slug);
  try {
    const result = await proxySvc.dispatch({
      provider, endpoint: 'images',
      body: { ...req.body, model: model.original_name },
      signal: req.signal,
    });
    const cost = proxySvc.computeCost(model, result.usage.inputTokens, result.usage.outputTokens);
    logger.write({
      apiKeyId: req.apiKey.id, providerId: provider.id, providerKeyId: result.providerKeyId,
      modelId: model.id, requestedModel: req.body.model, endpoint: 'images', category: 'image',
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, usageKnown: result.usage.known, cost,
      status: 'success', statusCode: result.status, clientIp: req.ip, userAgent: req.get('user-agent'),
    });
    apiKeys.touch(req.apiKey.id);
    res.json(result.json);
  } catch (err) {
    logger.write({
      apiKeyId: req.apiKey.id, requestedModel: req.body.model, endpoint: 'images',
      category: 'image', status: 'error', statusCode: err.status, errorMessage: err.message,
      clientIp: req.ip, userAgent: req.get('user-agent'),
    });
    res.status(err.status || 502).json({ error: { type: 'api_error', message: err.message } });
  }
});

/* ------------------------- audio (TTS / STT) ------------------------- */

router.post('/audio/speech', authMiddleware, async (req, res) => {
  const { models } = modelSvc.resolve(req.body.model);
  const scoped = modelSvc.applyScope(models, req.apiKey.model_scope);
  if (!scoped.length) return res.status(404).json({ error: { message: 'TTS modeli bulunamadı', type: 'invalid_request_error' } });

  const model = scoped[0];
  const provider = providerSvc.getProvider(model.provider_slug);
  try {
    const result = await proxySvc.dispatch({
      provider, endpoint: 'audio_speech',
      body: { ...req.body, model: model.original_name },
      signal: req.signal,
    });
    const cost = proxySvc.computeCost(model, result.usage.inputTokens, result.usage.outputTokens);
    logger.write({
      apiKeyId: req.apiKey.id, providerId: provider.id, providerKeyId: result.providerKeyId,
      modelId: model.id, requestedModel: req.body.model, endpoint: 'audio_speech', category: 'tts',
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, usageKnown: result.usage.known, cost,
      status: 'success', statusCode: result.status, clientIp: req.ip, userAgent: req.get('user-agent'),
    });
    apiKeys.touch(req.apiKey.id);
    res.json(result.json);
  } catch (err) {
    res.status(err.status || 502).json({ error: { type: 'api_error', message: err.message } });
  }
});

router.post('/audio/transcriptions', authMiddleware, async (req, res) => {
  const modelName = req.body?.model;
  const { models } = modelSvc.resolve(modelName);
  const scoped = modelSvc.applyScope(models, req.apiKey.model_scope);
  if (!scoped.length) return res.status(404).json({ error: { message: 'Transkripsiyon modeli bulunamadı', type: 'invalid_request_error' } });

  const model = scoped[0];
  const provider = providerSvc.getProvider(model.provider_slug);

  // multipart gövdeyi olduğu gibi ilet
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const rawBody = Buffer.concat(buffers);
  if (modelName) rawBody.write(`${model.original_name}\r\n`, rawBody.length);

  try {
    const result = await proxySvc.dispatch({
      provider, endpoint: 'audio_transcriptions',
      body: {}, rawBody, contentType: req.get('content-type') || '',
      signal: req.signal,
    });
    const cost = proxySvc.computeCost(model, result.usage.inputTokens, result.usage.outputTokens);
    logger.write({
      apiKeyId: req.apiKey.id, providerId: provider.id, providerKeyId: result.providerKeyId,
      modelId: model.id, requestedModel: modelName, endpoint: 'audio_transcriptions',
      category: 'transcription', status: 'success', statusCode: result.status,
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, usageKnown: result.usage.known, cost,
      clientIp: req.ip, userAgent: req.get('user-agent'),
    });
    apiKeys.touch(req.apiKey.id);
    res.json(result.json);
  } catch (err) {
    res.status(err.status || 502).json({ error: { type: 'api_error', message: err.message } });
  }
});

/* ---------------------------- genel hata ---------------------------- */

// /v1 altındaki tanımsız yollar
router.use((req, res) => {
  res.status(404).json({
    error: {
      type: 'invalid_request_error',
      code: 'unknown_endpoint',
      message: `Bilinmeyen uç nokta: ${req.method} /v1${req.path}. Desteklenen: /v1/models, /v1/chat/completions, /v1/completions, /v1/embeddings, /v1/images/generations, /v1/audio/speech, /v1/audio/transcriptions`,
    },
  });
});

module.exports = router;
