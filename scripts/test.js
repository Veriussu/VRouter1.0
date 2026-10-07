/**
 * VRouter uçtan uca test: anahtar rotasyonu, streaming, alias, limitler.
 * Kullanım: node scripts/test.js
 */
const BASE = 'http://localhost:10090';
const MOCK = 'http://127.0.0.1:10099/v1';

let pass = 0;
let fail = 0;

const c = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', y: '\x1b[33m', x: '\x1b[0m' };

function check(name, cond, extra = '') {
  if (cond) { console.log(`  ${c.g}✓${c.x} ${name}${extra ? ` ${c.d}${extra}${c.x}` : ''}`); pass++; }
  else { console.log(`  ${c.r}✗${c.x} ${name}${extra ? ` ${c.r}${extra}${c.x}` : ''}`); fail++; }
}

const req = async (method, path, { body, key, base = BASE } = {}) => {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* düz metin */ }
  return { status: r.status, json, text };
};

async function main() {
  console.log(`\n${c.x}VRouter test paketi${c.x}\n`);

  /* --------------------------- 0. Test verisini temizle --------------------------- */
  // Testler tekrar çalıştırılabilir olsun diye önceki kalıntıları sil
  {
    const { db } = require('../src/db');
    db.prepare("DELETE FROM api_keys WHERE name IN ('test-suite','limited','scoped','expired')").run();
    db.prepare("DELETE FROM request_logs WHERE requested_model = 'mock-model'").run();
    db.prepare("DELETE FROM provider_api_keys WHERE provider_id = 'testmock'").run();
    db.prepare("DELETE FROM models WHERE id = 'testmodel1'").run();
    db.prepare("DELETE FROM providers WHERE slug = 'testmock'").run();
    db.prepare("DELETE FROM provider_api_keys WHERE status = 'cooldown' OR status = 'invalid'").run();
    db.prepare("UPDATE provider_api_keys SET error_count = 0").run();
  }

  /* ------------------------------ 1. Sağlık ------------------------------ */
  console.log(`${c.y}[1] Temel uçlar${c.x}`);
  const health = await req('GET', '/health');
  check('GET /health', health.status === 200 && health.json.status === 'ok');

  const meta = await req('GET', '/v1');
  check('GET /v1 meta', meta.status === 200 && Array.isArray(meta.json.endpoints));

  const noAuth = await req('GET', '/v1/models');
  check('anahtarsız istek reddedilir (401)', noAuth.status === 401);

  const badAuth = await req('GET', '/v1/models', { key: 'vr_gecersiz' });
  check('geçersiz anahtar reddedilir (401)', badAuth.status === 401);

  /* --------------------------- 2. API anahtarı --------------------------- */
  console.log(`\n${c.y}[2] API anahtarı oluşturma${c.x}`);
  const created = await req('POST', '/admin/api/api-keys', { body: { name: 'test-suite', description: 'otomatik test' } });
  check('POST /admin/api/api-keys', created.status === 200 && !!created.json.data.key, created.json.data?.key?.slice(0, 12) + '…');
  const KEY = created.json.data.key;

  /* --------------------------- 3. Model listesi --------------------------- */
  console.log(`\n${c.y}[3] Model kataloğu${c.x}`);
  const all = await req('GET', '/v1/models', { key: KEY });
  check('GET /v1/models', all.status === 200 && Array.isArray(all.json.data), `${all.json.data?.length} model`);

  const cats = await req('GET', '/v1/models/categories', { key: KEY });
  check('GET /v1/models/categories', cats.status === 200 && cats.json.data.length > 5,
    cats.json.data?.slice(0, 6).map((c) => c.category).join(', '));

  for (const cat of ['chat', 'embedding', 'image', 'tts', 'reasoning']) {
    const r = await req('GET', `/v1/models?category=${cat}`, { key: KEY });
    const allMatch = r.json.data.every((m) => m.categories.includes(cat));
    check(`category=${cat} filtresi`, r.status === 200 && allMatch && r.json.data.length > 0, `${r.json.data.length} model`);
  }

  const search = await req('GET', '/v1/models?search=gpt-4o', { key: KEY });
  check('search filtresi', search.status === 200 && search.json.data.length > 0, `${search.json.data.length} sonuç`);

  /* ------------------------ 4. Mock sağlayıcı kurulumu ------------------------ */
  console.log(`\n${c.y}[4] Anahtar rotasyonu (failover)${c.x}`);

  const prov = await req('POST', '/admin/api/providers', {
    body: { name: 'Test Mock', slug: 'testmock', base_url: MOCK, api_format: 'openai' },
  });
  check('mock sağlayıcı oluşturuldu', prov.status === 200, prov.json.data?.slug);

  // Model kaydı oluştur (sağlayıcıya ait)
  const { db } = require('../src/db');
  db.prepare(
    `INSERT INTO models (id, provider_id, original_name, display_name, categories, capabilities, is_available)
     VALUES ('testmodel1','testmock','mock-model','Mock Model','["chat"]','["text_output"]',1)`
  ).run();

  // Anahtarlar: 1) 429 veren, 2) 401 veren, 3) çalışan
  const k1 = await req('POST', '/admin/api/providers/testmock/keys', { body: { key: 'fail-429-a', key_name: 'kota-dolu', priority: 0 } });
  const k2 = await req('POST', '/admin/api/providers/testmock/keys', { body: { key: 'fail-401-b', key_name: 'gecersiz', priority: 1 } });
  const k3 = await req('POST', '/admin/api/providers/testmock/keys', { body: { key: 'ok-c', key_name: 'calisan', priority: 2 } });
  check('3 anahtar eklendi', k1.status === 200 && k2.status === 200 && k3.status === 200);

  const masked = k3.json.data.find((k) => k.key_name === 'calisan');
  check('anahtar maskeli', masked?.key_mask === 'ok-c' || masked?.key_mask?.includes('*'), masked?.key_mask);

  // Tam adıyla model çağır → 429 → 401 → başarı
  const chat = await req('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'testmock/mock-model', messages: [{ role: 'user', content: 'merhaba' }] },
  });
  check('429 ve 401 sonrası 3. anahtara geçti', chat.status === 200 && chat.json.choices?.[0]?.message?.content,
    `attempts=${chat.json.usage ? 'ok' : '?'} cevap="${chat.json.choices?.[0]?.message?.content?.slice(0, 30)}"`);

  // Anahtar durumlarını kontrol et
  const keysAfter = await req('GET', '/admin/api/providers/testmock/keys');
  const byName = Object.fromEntries(keysAfter.json.data.map((k) => [k.key_name, k]));
  check('429 anahtarı soğutuldu', byName['kota-dolu'].status === 'cooldown', byName['kota-dolu'].status);
  check('401 anahtarı geçersiz işaretlendi', byName['gecersiz'].status === 'invalid', byName['gecersiz'].status);
  check('çalışan anahtar kullanım sayacı arttı', byName['calisan'].usage_count === 1, `usage=${byName['calisan'].usage_count}`);

  /* --------------------------- 5. Streaming --------------------------- */
  console.log(`\n${c.y}[5] Streaming${c.x}`);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'testmock/mock-model', messages: [{ role: 'user', content: 'test' }], stream: true }),
  });
  check('streaming 200', res.status === 200);
  check('SSE content-type', res.headers.get('content-type')?.includes('text/event-stream'));

  const raw = await res.text();
  const lines = raw.trim().split('\n').filter((l) => l.startsWith('data:'));
  check('SSE parçaları geldi', lines.length > 3, `${lines.length} olay`);
  check('[DONE] terminator gönderildi', raw.includes('data: [DONE]'));

  const text = lines
    .map((l) => l.slice(5).trim())
    .filter((s) => s !== '[DONE]')
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean)
    .map((e) => e.choices?.[0]?.delta?.content || '')
    .join('');
  check('stream içeriği birleşti', text.includes('Merhaba'), `"${text}"`);

  /* --------------------------- 6. Alias --------------------------- */
  console.log(`\n${c.y}[6] Model takma adı${c.x}`);
  const aliasRes = await req('PATCH', '/admin/api/models/testmodel1', { body: { alias: 'hizli-model' } });
  check('takma ad atandı', aliasRes.status === 200 && aliasRes.json.data.alias === 'hizli-model');

  const byAlias = await req('GET', '/v1/models/hizli-model', { key: KEY });
  check('alias ile model bulundu', byAlias.status === 200 && byAlias.json.data[0].id === 'hizli-model');

  const chatAlias = await req('POST', '/v1/chat/completions', {
    key: KEY, body: { model: 'hizli-model', messages: [{ role: 'user', content: 'alias testi' }] },
  });
  check('alias ile istek çalıştı', chatAlias.status === 200, chatAlias.json.choices?.[0]?.message?.content?.slice(0, 30));

  const dupAlias = await req('PATCH', '/admin/api/models/testmodel1', { body: { alias: 'çakışan!' } });
  check('geçersiz alias reddedildi', dupAlias.status === 400, dupAlias.json.error);

  /* --------------------------- 7. Limitler --------------------------- */
  console.log(`\n${c.y}[7] Limitler ve kısıtlar${c.x}`);

  const limited = await req('POST', '/admin/api/api-keys', {
    body: { name: 'limited', rate_limit: 2, daily_request_limit: 100 },
  });
  const LKEY = limited.json.data.key;

  await req('POST', '/v1/chat/completions', { key: LKEY, body: { model: 'hizli-model', messages: [{ role: 'user', content: '1' }] } });
  await req('POST', '/v1/chat/completions', { key: LKEY, body: { model: 'hizli-model', messages: [{ role: 'user', content: '2' }] } });
  const overLimit = await req('POST', '/v1/chat/completions', { key: LKEY, body: { model: 'hizli-model', messages: [{ role: 'user', content: '3' }] } });
  check('dakikalık istek limiti uygulandı', overLimit.status === 429, overLimit.json.error?.code);

  const scoped = await req('POST', '/admin/api/api-keys', {
    body: { name: 'scoped', models: ['hizli-model'] },
  });
  const SKEY = scoped.json.data.key;

  const allowedModel = await req('POST', '/v1/chat/completions', {
    key: SKEY, body: { model: 'hizli-model', messages: [{ role: 'user', content: 'ok' }] },
  });
  check('kapsam içi modele erişim', allowedModel.status === 200);

  const deniedModel = await req('POST', '/v1/chat/completions', {
    key: SKEY, body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'no' }] },
  });
  check('kapsam dışı model engellendi (403)', deniedModel.status === 403, deniedModel.json.error?.message?.slice(0, 50));

  const expired = await req('POST', '/admin/api/api-keys', {
    body: { name: 'expired', valid_until: '2020-01-01' },
  });
  const expiredRes = await req('POST', '/v1/chat/completions', {
    key: expired.json.data.key, body: { model: 'hizli-model', messages: [{ role: 'user', content: 'x' }] },
  });
  check('süresi geçmiş anahtar reddedildi (403)', expiredRes.status === 403, expiredRes.json.error?.code);

  /* --------------------------- 8. Hatalar --------------------------- */
  console.log(`\n${c.y}[8] Hata yönetimi${c.x}`);
  const noModel = await req('POST', '/v1/chat/completions', {
    key: KEY, body: { model: 'boyle-bir-model-yok', messages: [{ role: 'user', content: 'x' }] },
  });
  check('bulunamayan model (404)', noModel.status === 404);

  const noKeyProvider = await req('POST', '/v1/chat/completions', {
    key: KEY, body: { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'x' }] },
  });
  check('anahtarsız sağlayıcı hatası aktarıldı', noKeyProvider.status === 429, noKeyProvider.json.error?.message?.slice(0, 60));

  const badEndpoint = await req('POST', '/v1/yok-boyle-uc', { key: KEY, body: {} });
  check('bilinmeyen uç (404)', badEndpoint.status === 404, badEndpoint.json.error?.code);

  /* --------------------------- 9. Loglar --------------------------- */
  console.log(`\n${c.y}[9] Log ve istatistik${c.x}`);
  await new Promise((r) => setTimeout(r, 300));
  const logs = await req('GET', '/admin/api/logs?limit=50', {});
  check('loglar kaydedildi', logs.status === 200 && logs.json.total > 0, `${logs.json.total} kayıt`);

  const successLogs = logs.json.rows.filter((l) => l.status === 'success');
  check('başarılı istekler loglandı', successLogs.length > 0, `${successLogs.length} başarılı`);
  check('streaming loglandı', logs.json.rows.some((l) => l.stream === 1));
  check('failover deneme sayısı loglandı', logs.json.rows.some((l) => l.attempts > 1),
    `max attempts=${Math.max(...logs.json.rows.map((l) => l.attempts))}`);

  const stats = await req('GET', '/admin/api/stats', {});
  check('istatistikler', stats.status === 200 && stats.json.counts.providers > 0,
    `sağlayıcı=${stats.json.counts.providers} model=${stats.json.counts.models}`);

  /* --------------------------- 10. Sıkıştırma --------------------------- */
  console.log(`\n${c.y}[10] Token sıkıştırma${c.x}`);
  const { compress } = require('../src/services/compressor');

  const longMessages = [
    { role: 'system', content: 'Sistem talimatı'.repeat(100) },
    { role: 'user', content: '  bir   \n\n\n\n iki  '.repeat(400) },
    { role: 'user', content: '  bir   \n\n\n\n iki  '.repeat(400) },
    { role: 'assistant', content: 'cevap' },
  ];
  const r1 = compress({ messages: longMessages });
  check('tekrar eden mesaj kaldırıldı', r1.savedTokens > 0, `${r1.savedTokens} token tasarruf, notlar: ${r1.notes.join(', ')}`);

  const short = compress({ messages: [{ role: 'user', content: 'kısa' }] });
  check('kısa mesajlara dokunulmadı', short.applied === false, short.notes[0]);

  const r2 = compress({ messages: [{ role: 'user', content: 'a'.repeat(20000) }] });
  check('ilk/son mesaj korunuyor', r2.body.messages[0].content.length === 20000);

  /* --------------------------- 11. Yerleşikler --------------------------- */
  console.log(`\n${c.y}[11] Yerleşik sağlayıcılar${c.x}`);
  for (const slug of ['local', 'vprovider', 'veriussu']) {
    const p = await req('GET', `/admin/api/providers`);
    const found = p.json.data.find((x) => x.slug === slug);
    check(`${slug} mevcut`, !!found, found?.name);
  }
  const delLocal = await req('DELETE', '/admin/api/providers/local');
  check('yerleşik sağlayıcı silinemez', delLocal.status === 400, delLocal.json.error?.slice(0, 40));

  /* ------------------------------- Sonuç ------------------------------- */
  console.log(`\n${c.x}${'─'.repeat(52)}${c.x}`);
  console.log(`  ${c.g}başarılı: ${pass}${c.x}   ${fail ? c.r : c.d}başarısız: ${fail}${c.x}`);
  console.log(`${c.x}${'─'.repeat(52)}${c.x}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest paketi çöktü:', err);
  process.exit(1);
});
