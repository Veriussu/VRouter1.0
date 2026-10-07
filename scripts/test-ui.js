/**
 * Arayüz akışı testi: arayüzün kullandığı API sözleşmesini taklit eder.
 * 1) Sağlayıcı listesi + key_state
 * 2) Listeden sağlayıcı seç → anahtar ekle → aktif olur
 * 3) Sadece aktif anahtarı olanlar listelenir (arayüzün filtresi)
 */
const BASE = 'http://localhost:10090';

let pass = 0, fail = 0;
const c = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', x: '\x1b[0m' };
const check = (n, ok, extra = '') => {
  if (ok) { console.log(`  ${c.g}✓${c.x} ${n}${extra ? ` ${c.d}${extra}${c.x}` : ''}`); pass++; }
  else { console.log(`  ${c.r}✗${c.x} ${n}${extra ? ` ${c.r}${extra}${c.x}` : ''}`); fail++; }
};

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, json: await r.json().catch(() => null) };
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const patch = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

async function main() {
  console.log(`\n${c.x}VRouter arayüz akışı testi${c.x}\n`);

  // Temizlik
  {
    const { db } = require('../src/db');
    db.prepare("DELETE FROM provider_api_keys WHERE provider_id = 'uitest'").run();
    db.prepare("DELETE FROM providers WHERE slug = 'uitest'").run();
  }

  /* --- 1) Liste sözleşmesi --- */
  console.log(`${c.g}[1] Sağlayıcı listesi sözleşmesi${c.x}`);
  const list = await get('/admin/api/providers');
  check('GET /admin/api/providers', list.status === 200 && Array.isArray(list.json.data));

  const sample = list.json.data[0];
  check('her kayıtta key_state var', list.json.data.every((p) => p.key_state && typeof p.key_state.total === 'number'));
  check('key_state.active sayı', list.json.data.every((p) => typeof p.key_state.active === 'number'));
  check('her kayıtta logo_url/model sayısı', list.json.data.every((p) => 'logo_url' in p && 'available_model_count' in p));
  check('modal araması için name/slug/base_url', list.json.data.every((p) => p.name && p.slug && p.base_url));

  /* --- 2) Arayüzün "sadece aktifler" filtresi --- */
  const beforeActive = list.json.data.filter((p) => (p.key_state?.active || 0) > 0);
  check('arayüz listelemesi 1 sağlayıcı döndü', beforeActive.length >= 1, `${beforeActive.length} aktif`);

  /* --- 3) Sağlayıcı seç → anahtar gir → aktif ol --- */
  console.log(`\n${c.g}[2] Sağlayıcı ekleme akışı${c.x}`);

  const target = list.json.data.find((p) => p.slug === 'local');
  check('local sağlayıcısı katalogda', !!target, target?.name);

  const emptyForm = await post('/admin/api/providers/local/keys', { key: '' });
  check('boş anahtar reddedildi (400)', emptyForm.status === 400, emptyForm.json.error);

  const added = await post('/admin/api/providers/local/keys', {
    key: 'ui-test-key-1234567890',
    key_name: 'Test Anahtarı',
    priority: 0,
  });
  check('anahtar eklendi', added.status === 200 && Array.isArray(added.json.data));

  const masked = added.json.data[0];
  check('anahtar maskeli döndü', masked.key_mask.includes('*'), masked.key_mask);
  check('şifreli anahtar sızmadı', !JSON.stringify(added.json).includes('ui-test-key-1234567890'));

  /* --- 4) Aktif olmuş mu? --- */
  const after = await get('/admin/api/providers');
  const localAfter = after.json.data.find((p) => p.slug === 'local');
  check('local artık aktif', (localAfter.key_state.active || 0) > 0, `active=${localAfter.key_state.active}`);
  check('local artık arayüz listesinde görünür', (localAfter.key_state.active || 0) > 0);

  const stillInactive = after.json.data.filter(
    (p) => p.slug !== 'local' && p.slug !== 'testmock' && (p.key_state?.active || 0) > 0
  );
  check('diğer sağlayıcılar pasif kaldı', stillInactive.length === 0, `${stillInactive.length} sızıntı`);

  /* --- 5) Modal placeholder uyarısı için metadata --- */
  const azure = after.json.data.find((p) => p.slug === 'azure');
  check('placeholder sağlayıcı metadata.placeholder_url işaretli',
    azure?.metadata?.placeholder_url === true || /YOUR-/.test(azure?.base_url || ''),
    azure?.metadata?.placeholder_url ? 'placeholder_url=true' : 'base_url placeholder içeriyor');

  /* --- 6) Temizlik --- */
  console.log(`\n${c.g}[3] Temizlik${c.x}`);
  const keys = await get('/admin/api/providers/local/keys');
  const testKeyId = keys.json.data.find((k) => k.key_name === 'Test Anahtarı')?.id;
  const del = await fetch(`${BASE}/admin/api/keys/${testKeyId}`, { method: 'DELETE' });
  check('test anahtarı silindi', del.status === 200);

  const restored = await get('/admin/api/providers');
  const localFinal = restored.json.data.find((p) => p.slug === 'local');
  check('local tekrar pasif duruma döndü', (localFinal.key_state.active || 0) === 0);

  console.log(`\n${c.x}${'─'.repeat(46)}${c.x}`);
  console.log(`  ${c.g}başarılı: ${pass}${c.x}   ${fail ? c.r : c.d}başarısız: ${fail}${c.x}`);
  console.log(`${c.x}${'─'.repeat(46)}${c.x}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Çöktü:', e); process.exit(1); });
