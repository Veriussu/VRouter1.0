const fs = require('fs');
const V1 = '/home/dante/Project/VRouter/src/routes/v1.js';
let v1 = fs.readFileSync(V1, 'utf8');
const fail = (m) => { console.error('BULUNAMADI: ' + m); process.exit(1); };

/* 1) chat/completions ana kontrolü: silinmiş ayrımı */
const oldMain = `    const provider = providerSvc.getProvider(model.provider_slug);
    if (!provider || !provider.is_active) {
      errors.push(\`\${model.provider_slug}: sağlayıcı pasif\`);`;

const newMain = `    const provider = providerSvc.getProvider(model.provider_slug);
    if (!provider || provider.is_deleted) {
      errors.push(\`\${model.provider_slug}: sağlayıcı silinmiş\`);
      lastRes = new proxySvc.UpstreamError(\`"\${model.provider_slug}" sağlayıcısı silinmiş\`, {
        status: 503, kind: 'server', retryable: true,
      });
      continue;
    }
    if (!provider.is_active) {
      errors.push(\`\${model.provider_slug}: sağlayıcı pasif\`);`;

if (!v1.includes(oldMain)) fail('chat kontrolü');
v1 = v1.replace(oldMain, newMain);

/* 2) diğer uçlar: silinmiş/pasif sağlayıcıyı reddet */
const guard = `  const provider = providerSvc.getProvider(model.provider_slug);
  if (!provider || provider.is_deleted || !provider.is_active) {
    return res.status(503).json({
      error: {
        type: 'api_error',
        code: 'provider_unavailable',
        message: \`"\${provider?.name || model.provider_slug}" sağlayıcısı kullanılamıyor\`,
      },
    });
  }`;

const target = `  const provider = providerSvc.getProvider(model.provider_slug);
  if (!provider || !provider.is_active) {`;

const endpoints = ['/embeddings', '/images/generations', '/audio/speech', '/audio/transcriptions'];
let n = 0;
for (const ep of endpoints) {
  const start = v1.indexOf(`router.post('${ep}'`);
  if (start < 0) fail('uç yok: ' + ep);
  const idx = v1.indexOf(target, start);
  if (idx < 0) fail('guard yok: ' + ep);
  // sonraki uçtan önce olduğunu doğrula
  const nextRoute = v1.indexOf('\nrouter.post(', start + 10);
  if (nextRoute > 0 && idx > nextRoute) fail('guard yanlış yerde: ' + ep);
  v1 = v1.slice(0, idx) + guard + v1.slice(idx + target.length);
  n++;
}

fs.writeFileSync(V1, v1);
console.log(`v1.js güncellendi — ${n} uç + chat kontrolü`);
