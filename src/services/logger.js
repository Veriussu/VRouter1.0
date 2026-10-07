const crypto = require('crypto');
const { db } = require('../db');

const uid = () => crypto.randomUUID();

function write(entry) {
  try {
    db.prepare(
      `INSERT INTO request_logs
        (id, api_key_id, provider_id, provider_key_id, model_id, requested_model, endpoint,
         category, stream, input_tokens, output_tokens, total_tokens, usage_known, cost, latency_ms,
         status, status_code, error_message, compressed, saved_tokens, attempts, client_ip, user_agent)
       VALUES (@id, @api_key_id, @provider_id, @provider_key_id, @model_id, @requested_model, @endpoint,
               @category, @stream, @input_tokens, @output_tokens, @total_tokens, @usage_known, @cost, @latency_ms,
               @status, @status_code, @error_message, @compressed, @saved_tokens, @attempts, @client_ip, @user_agent)`
    ).run({
      id: uid(),
      api_key_id: entry.apiKeyId ?? null,
      provider_id: entry.providerId ?? null,
      provider_key_id: entry.providerKeyId ?? null,
      model_id: entry.modelId ?? null,
      requested_model: entry.requestedModel ?? null,
      endpoint: entry.endpoint ?? null,
      category: entry.category ?? null,
      stream: entry.stream ? 1 : 0,
      input_tokens: entry.inputTokens ?? 0,
      output_tokens: entry.outputTokens ?? 0,
      total_tokens: (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
      usage_known: entry.usageKnown ? 1 : 0,
      cost: entry.cost ?? 0,
      latency_ms: entry.latencyMs ?? null,
      status: entry.status,
      status_code: entry.statusCode ?? null,
      error_message: entry.errorMessage ? String(entry.errorMessage).slice(0, 1000) : null,
      compressed: entry.compressed ? 1 : 0,
      saved_tokens: entry.savedTokens ?? 0,
      attempts: entry.attempts ?? 1,
      client_ip: entry.clientIp ?? null,
      user_agent: (entry.userAgent || '').slice(0, 200) || null,
    });
  } catch (err) {
    console.error('[log] yazma hatası:', err.message);
  }
}

function query({ limit = 50, offset = 0, apiKeyId, providerId, modelId, status, from, to, search } = {}) {
  const where = [];
  const params = {};

  if (apiKeyId) { where.push('l.api_key_id = @apiKeyId'); params.apiKeyId = apiKeyId; }
  if (providerId) { where.push('l.provider_id = @providerId'); params.providerId = providerId; }
  if (modelId) { where.push('l.model_id = @modelId'); params.modelId = modelId; }
  if (status) { where.push('l.status = @status'); params.status = status; }
  if (from) { where.push('l.created_at >= @from'); params.from = from; }
  if (to) { where.push('l.created_at <= @to'); params.to = to; }
  if (search) {
    where.push('(l.requested_model LIKE @search OR l.error_message LIKE @search)');
    params.search = `%${search}%`;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT l.*, p.name AS provider_name, p.slug AS provider_slug, m.display_name, k.key_mask
       FROM request_logs l
       LEFT JOIN providers p ON p.id = l.provider_id
       LEFT JOIN models m ON m.id = l.model_id
       LEFT JOIN provider_api_keys k ON k.id = l.provider_key_id
       ${clause}
       ORDER BY l.created_at DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: Math.min(limit, 500), offset });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM request_logs l ${clause}`).get(params).n;
  return { rows, total };
}

function stats({ hours = 24 } = {}) {
  const since = `-${parseInt(hours, 10)} hours`;
  const base = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              SUM(status = 'success') AS success,
              SUM(status = 'error')   AS errors,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0)  AS total_tokens,
              COALESCE(SUM(saved_tokens), 0)   AS saved_tokens,
              COALESCE(SUM(cost), 0)          AS cost,
              AVG(latency_ms)                 AS avg_latency
       FROM request_logs WHERE created_at >= datetime('now', ?)`
    )
    .get(since);

  const byProvider = db
    .prepare(
      `SELECT p.name AS provider, COUNT(*) AS requests, COALESCE(SUM(l.cost),0) AS cost,
              COALESCE(SUM(l.total_tokens),0) AS tokens
       FROM request_logs l LEFT JOIN providers p ON p.id = l.provider_id
       WHERE l.created_at >= datetime('now', ?)
       GROUP BY l.provider_id ORDER BY requests DESC LIMIT 10`
    )
    .all(since);

  const byModel = db
    .prepare(
      `SELECT COALESCE(m.display_name, l.requested_model) AS model, COUNT(*) AS requests,
              COALESCE(SUM(l.total_tokens),0) AS tokens, COALESCE(SUM(l.cost),0) AS cost
       FROM request_logs l LEFT JOIN models m ON m.id = l.model_id
       WHERE l.created_at >= datetime('now', ?)
       GROUP BY COALESCE(m.display_name, l.requested_model)
       ORDER BY requests DESC LIMIT 10`
    )
    .all(since);

  const timeline = db
    .prepare(
      `SELECT strftime('%Y-%m-%d %H:00', created_at) AS hour,
              COUNT(*) AS requests,
              COALESCE(SUM(total_tokens),0) AS tokens,
              COALESCE(SUM(cost),0) AS cost
       FROM request_logs WHERE created_at >= datetime('now', ?)
       GROUP BY hour ORDER BY hour ASC`
    )
    .all(since);

  return { summary: base, byProvider, byModel, timeline };
}

function purge(days = 30) {
  return db.prepare(`DELETE FROM request_logs WHERE created_at < datetime('now', ?)`).run(`-${parseInt(days, 10)} days`).changes;
}

module.exports = { write, query, stats, purge };
