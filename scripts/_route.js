const fs = require('fs');

const fail = (m) => { console.error('BULUNAMADI: ' + m); process.exit(1); };
const swapIn = (file, from, to, label) => {
  let out = fs.readFileSync(file, 'utf8');
  if (!out.includes(from)) fail(label);
  out = out.replace(from, to);
  fs.writeFileSync(file, out);
};

/* 1) models.js: silinmiş sağlayıcıların modelleri rotasyona katılmasın */
swapIn(
  '/home/dante/Project/VRouter/src/services/models.js',
  "  const where = activeOnly ? 'WHERE m.is_active = 1' : '';",
  "  // Silinmiş sağlayıcıların modelleri rotasyona katılmaz\n  const where = activeOnly ? 'WHERE m.is_active = 1 AND p.is_deleted = 0' : '';",
  'allModels filtresi'
);

/* 2) v1.js: silinmiş sağlayıcı hata olarak dönmeli */
const V1 = '/home/dante/Project/VRouter/src/routes/v1.js';
let v1 = fs.readFileSync(V1, 'utf8');

const oldMain = `    const provider = providerSvc.getProvider(model.provider_slug);
    if (!provider || !provider.is_active) {
      errors.push(\`\${model.provider_slug}: sağlayıcı pasif\`);
      lastRes = new proxySvc.UpstreamError(\`"\${model.provider_slug}" sağlayıcısı pasif durumda\`, {
        status: 503, kind: 'server', retryable: true,
      });
      continue;
    }`;

const newMain = `    const provider = providerSvc.getProvider(model.provider_slug);
    if (!provider || provider.is_deleted) {
      errors.push(\`\${model.provider_slug}: sağlayıcı silinmiş\`);
      lastRes = new proxySvc.UpstreamError(\`"\${model.provider_slug}" sağlayıcısı silinmiş\`, {
        status: 503, kind: 'server', retryable: true,
      });
      continue;
    }
    if (!provider.is_active) {
      errors.push(\`\${model.provider_slug}: sağlayıcı pasif\`);
      lastRes = new proxySvc.UpstreamError(\`"\${model.provider_slug}" sağlayıcısı pasif durumda\`, {
        status: 503, kind: 'server', retryable: true,
      });
      continue;
    }`;

if (!v1.includes(oldMain)) fail('v1 ana kontrol');
v1 = v1.replace(oldMain, newMain);

// Diğer uçlar (embeddings, images, audio) silinmiş sağlayıcıyı reddetmeli
const guard = `  const provider = providerSvc.getProvider(model.provider_slug);
  if (!provider || !provider.is_active || provider.is_deleted) {
    return res.status(503).json({
      error: { type: 'api_error', code: 'provider_unavailable', message: \`"\${provider?.name || model.provider_slug}" sağlayıcısı kullanılamıyor\` },
    });
  }`;

const anchors = ['/v1/embeddings', '/v1/images/generations', '/v1/audio/speech', '/v1/audio/transcriptions'];
let replaced = 0;
for (const ep of anchors) {
  const start = v1.indexOf(`router.post('${ep}'`);
  if (start < 0) fail('uç bulunamadı: ' + ep);
  const target = `  const provider = providerSvc.getProvider(model.provider_slug);
  if (!provider || !provider.is_active) {`;
  const idx = v1.indexOf(target, start);
  if (idx < 0) { fail('guard bulunamadı: ' + ep); }
  v1 = v1.slice(0, idx) + guard + v1.slice(idx + target.length);
  replaced++;
}

fs.writeFileSync(V1, v1);
console.log(`models.js + v1.js güncellendi (${replaced} uç korundu)`);
