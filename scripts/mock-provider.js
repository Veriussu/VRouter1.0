/**
 * Test amaçlı sahte sağlayıcı (mock upstream).
 *
 * Davranış kuralı:
 *   Authorization: Bearer <key>
 *   - "fail-429"  -> 429 (kota) döner
 *   - "fail-401"  -> 401 döner
 *   - "ok"        -> 200 + geçerli OpenAI yanıtı döner
 *   - "flaky:N"   -> ilk N istekte 429, sonra 200
 */
const http = require('http');

const state = {};

const server = http.createServer(async (req, res) => {
  const key = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* yoksay */ }

  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
  }

  const send = (status, payload, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };

  state.calls = (state.calls || 0) + 1;
  console.log(`[mock] #${state.calls} key=${key} model=${body.model}`);

  if (key.startsWith('fail-429')) {
    return send(429, { error: { message: 'Rate limit exceeded for quota' } }, { 'retry-after': '2' });
  }
  if (key.startsWith('fail-401')) {
    return send(401, { error: { message: 'Invalid API key' } });
  }
  if (key.startsWith('fail-400')) {
    return send(400, { error: { message: 'Bad request: model not found' } });
  }
  if (key.startsWith('flaky')) {
    const n = parseInt(key.split(':')[1] || '1', 10);
    const count = (state['flaky_' + key] = (state['flaky_' + key] || 0) + 1);
    if (count <= n) return send(429, { error: { message: 'quota exceeded' } });
  }

  if (body.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    for (const word of ['Merhaba', ' bu', ' bir', ' test', ' cevabı', '.']) {
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', model: body.model, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  send(200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Merhaba! Bu bir test cevabı.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  });
});

server.listen(10099, '127.0.0.1', () => console.log('[mock] 127.0.0.1:10099 hazır'));
