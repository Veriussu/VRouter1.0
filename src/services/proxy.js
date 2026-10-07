const { Readable } = require('stream');
const config = require('../config');
const rotator = require('./keyRotator');
const { decrypt } = require('../crypto');
const logger = require('./logger');

/**
 * Sağlayıcıya isteği iletir, streaming destekler ve
 * anahtar hatalarında diğer anahtarlara otomatik geçer.
 */

class UpstreamError extends Error {
  constructor(message, { status = 502, kind = 'server', retryable = false } = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** Sağlayıcının bu uç için doğru yolu üretir */
function buildUrl(provider, endpoint) {
  const base = String(provider.base_url || '').replace(/\/+$/, '');
  switch (endpoint) {
    case 'chat':
      return `${base}/chat/completions`;
    case 'completions':
      return `${base}/completions`;
    case 'embeddings':
      return `${base}/embeddings`;
    case 'models':
      return `${base}/models`;
    case 'images':
      return `${base}/images/generations`;
    case 'audio_speech':
      return `${base}/audio/speech`;
    case 'audio_transcriptions':
      return `${base}/audio/transcriptions`;
    default:
      return `${base}/chat/completions`;
  }
}

function authHeaders(providerKey, provider) {
  if (provider.api_format === 'anthropic') {
    return {
      'x-api-key': providerKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  }
  return { authorization: `Bearer ${providerKey}`, 'content-type': 'application/json' };
}

/** Anthropic biçimine dönüştür */
function toAnthropic(body) {
  const system = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const messages = (body.messages || [])
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const out = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: !!body.stream,
  };
  if (system) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return out;
}

/** Anthropic yanıtını OpenAI biçimine çevir */
function fromAnthropic(data, requestedModel) {
  const text = (data.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  };
}

/** Maliyet hesapla (models.dev cost = 1M token USD) */
function computeCost(model, inputTokens, outputTokens) {
  if (!model?.pricing) return 0;
  let p;
  try { p = JSON.parse(model.pricing); } catch { return 0; }
  if (!p || typeof p !== 'object') return 0;

  const per1M = (v) => (typeof v === 'number' ? v : 0);
  const cost = (inputTokens / 1e6) * per1M(p.input) + (outputTokens / 1e6) * per1M(p.output);
  return Number(cost.toFixed(8));
}

/**
 * Anahtar döngüsü ile isteği gönderir.
 *
 * @param {object} opts
 * @param {object} opts.provider
 * @param {string} opts.endpoint
 * @param {object} opts.body
 * @param {boolean} opts.stream
 * @param {AbortSignal} opts.signal
 */
async function dispatch({ provider, endpoint, body, stream = false, signal, rawBody = null, contentType = 'application/json' }) {
  const keys = rotator.availableKeys(provider.id);

  if (keys.length === 0) {
    const state = rotator.providerKeyState(provider.id);
    const total = state?.total ?? 0;
    throw new UpstreamError(
      total === 0
        ? `"${provider.name}" sağlayıcısı için API anahtarı tanımlanmamış`
        : `"${provider.name}" sağlayıcısının tüm API anahtarları şu anda kullanılamaz durumda`,
      { status: 429, kind: 'quota', retryable: false }
    );
  }

  const url = buildUrl(provider, endpoint);
  let lastError = null;
  let attempts = 0;

  for (const keyRow of keys) {
    attempts++;
    const plain = decrypt(keyRow.key_encrypted);
    if (!plain) continue;

    const isAnthropic = provider.api_format === 'anthropic';
    const payload = rawBody ?? (isAnthropic ? toAnthropic(body) : body);
    const headers = authHeaders(plain, provider);
    if (rawBody && contentType.includes('multipart')) delete headers['content-type'];

    const startedAt = Date.now();
    let res;

    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: rawBody ?? JSON.stringify(payload),
        signal: signal || AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const kind = 'network';
      rotator.coolDown(keyRow.id, kind, { errorCount: keyRow.error_count, message: err.message });
      lastError = new UpstreamError(`Bağlantı hatası: ${err.message}`, { status: 502, kind, retryable: true });
      continue; // sıradaki anahtarı dene
    }

    // Başarılı
    if (res.ok) {
      rotator.markUsed(keyRow.id);

      if (stream) {
        return await readStream(res, { provider, body, startedAt, keyRow, attempts });
      }

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new UpstreamError('Sağlayıcı geçersiz JSON döndürdü', { status: 502 }); }

      const out = isAnthropic && data.content ? fromAnthropic(data, body.model) : data;
      const usage = out.usage || {};
      const inputKnown = usage.prompt_tokens != null || usage.input_tokens != null;
      const outputKnown = usage.completion_tokens != null || usage.output_tokens != null;
      return {
        json: out,
        status: res.status,
        providerKeyId: keyRow.id,
        latencyMs: Date.now() - startedAt,
        attempts,
        usage: {
          inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
          known: inputKnown || outputKnown,
        },
      };
    }

    // Hata durumu
    const errText = await res.text().catch(() => '');
    const cls = rotator.classifyError(res.status, errText);
    rotator.coolDown(keyRow.id, cls.kind, {
      retryAfter: res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset-requests'),
      errorCount: keyRow.error_count,
      message: errText,
    });

    lastError = new UpstreamError(extractMessage(errText) || cls.message, {
      status: res.status,
      kind: cls.kind,
      retryable: cls.retryable,
    });

    // İstek hatası (400/404/422) -> başka anahtar denemenin anlamı yok
    if (!cls.retryable) break;

    console.warn(`[proxy] ${provider.slug} anahtar ${keyRow.id.slice(0, 8)} → ${cls.kind}, sıradaki anahtar deneniyor`);
  }

  throw lastError || new UpstreamError('Sağlayıcıya ulaşılamadı', { status: 502 });
}

function extractMessage(bodyText) {
  if (!bodyText) return '';
  try {
    const d = JSON.parse(bodyText);
    return d.error?.message || d.message || d.detail || String(bodyText).slice(0, 300);
  } catch {
    return String(bodyText).slice(0, 300);
  }
}

/**
 * SSE akışını okur ve OpenAI biçiminde yeniden paketler.
 * Node Readable döndürür; rota tarafında doğrudan res'e pipe edilir.
 */
async function readStream(res, { provider, body, startedAt, keyRow, attempts }) {
  const isAnthropic = provider.api_format === 'anthropic';

  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let usageKnown = false;
  let modelId = null;
  let messageId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let firstSent = false;
  let finishReason = 'stop';

  const decoder = new TextDecoder();

  const usageRef = { inputTokens: 0, outputTokens: 0 };
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const countTokens = (text) => Math.ceil(String(text).length / 4);

  const pump = new Readable({
    read() {}, // aşağıdaki async döngü veri yazar
    highWaterMark: 1,
  });

  const emit = (str) => {
    if (!pump.push(str)) { /* backpressure yok, kabul */ }
  };

  const startChunk = () => {
    if (firstSent) return;
    firstSent = true;
    emit(sse({
      id: messageId,
      object: 'chat.completion.chunk',
      created,
      model: modelId || body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }));
  };

  // Arka planda okuma döngüsü
  (async () => {
    try {
      for await (const chunk of res.body) {
        if (pump.destroyed) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          let evt;
          try { evt = JSON.parse(dataStr); } catch { continue; }

          if (isAnthropic) {
            if (evt.type === 'message_start') {
              messageId = evt.message?.id || messageId;
              modelId = evt.message?.model || modelId;
              inputTokens = evt.message?.usage?.input_tokens ?? 0;
              usageKnown = evt.message?.usage?.input_tokens != null || usageKnown;
            } else if (evt.type === 'content_block_delta' && evt.delta?.text) {
              startChunk();
              outputTokens += countTokens(evt.delta.text);
              emit(sse({
                id: messageId, object: 'chat.completion.chunk', created,
                model: modelId || body.model,
                choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }],
              }));
            } else if (evt.type === 'message_delta') {
              outputTokens = evt.usage?.output_tokens ?? outputTokens;
              usageKnown = evt.usage?.output_tokens != null || usageKnown;
              if (evt.delta?.stop_reason === 'max_tokens') finishReason = 'length';
            } else if (evt.type === 'error') {
              emit(sse({ error: evt.error || { message: 'bilinmeyen hata' } }));
            }
          } else {
            modelId = evt.model || modelId;
            if (evt.usage?.prompt_tokens != null) inputTokens = evt.usage.prompt_tokens;
            if (evt.usage?.completion_tokens != null) outputTokens = evt.usage.completion_tokens;
            if (evt.usage?.prompt_tokens != null || evt.usage?.completion_tokens != null) usageKnown = true;

            const choice = evt.choices?.[0];
            const delta = choice?.delta;
            if (delta?.content) {
              startChunk();
              if (evt.usage == null) outputTokens += countTokens(delta.content);
            }
            if (choice?.finish_reason) {
              startChunk();
              finishReason = choice.finish_reason === 'length' ? 'length' : 'stop';
            }
            if (delta || choice || evt.usage) emit(sse(evt));
          }
        }
      }

      // Akış sonu: kullanım bilgisini ekle
      if (!isAnthropic) {
        startChunk();
        emit(sse({
          id: messageId, object: 'chat.completion.chunk', created,
          model: modelId || body.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        }));
      }
      emit('data: [DONE]\n\n');
    } catch (err) {
      if (!pump.destroyed) {
        emit(sse({ error: { message: err.message, type: 'upstream_error' } }));
        emit('data: [DONE]\n\n');
      }
    } finally {
      usageRef.inputTokens = inputTokens;
      usageRef.outputTokens = outputTokens;
      usageRef.known = usageKnown;
      if (!pump.destroyed) pump.push(null);
    }
  })();

  return {
    stream: pump,
    status: res.status,
    providerKeyId: keyRow.id,
    attempts,
    getLatency: () => Date.now() - startedAt,
    getUsage: () => ({ inputTokens: usageRef.inputTokens, outputTokens: usageRef.outputTokens, known: usageRef.known }),
    getModelId: () => modelId,
  };
}

module.exports = { dispatch, buildUrl, computeCost, UpstreamError };
