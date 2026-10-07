const fs = require('fs');
const V1 = '/home/dante/Project/VRouter/src/routes/v1.js';
let v1 = fs.readFileSync(V1, 'utf8');
const fail = (m) => { console.error('BULUNAMADI: ' + m); process.exit(1); };

/* 1) chat/completions: silinmiş ve pasif ayrımı */
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

/* 2) diğer uçlar: provider kullanılabilirliği kontrolü ekle
      (bu uçlarda koruma yoktu, doğrudan dispatch'e gidiyordu) */
const anchor = `  const provider = providerSvc.getProvider(model.provider_slug);
  try {`;

const guard = `  const provider = providerSvc.getProvider(model.provider_slug);
  if (!provider || provider.is_deleted || !provider.is_active) {
    return res.status(503).json({
      error: {
        type: 'api_error',
        code: 'provider_unavailable',
        message: \`"\${provider?.name || model.provider_slug}" sağlayıcısı kullanılamıyor\`,
      },
    });
  }
  try {`;

const endpoints = ['/embeddings', '/images/generations', '/audio/speech', '/audio/transcriptions'];
let n = 0;
for (const ep of endpoints) {
  const start = v1.indexOf(`router.post('${ep}'`);
  if (start < 0) fail('uç yok: ' + ep);

  const nextRoute = v1.indexOf('\nrouter.', start + 10);
  const end = nextRoute > 0 ? nextRoute : v1.length;

  const idx = v1.indexOf(anchor, start);
  if (idx < 0 || idx > end) fail('guard yok/yansız: ' + ep);

  v1 = v1.slice(0, idx) + guard + v1.slice(idx + anchor.length);
  n++;
}

fs.writeFileSync(V1, v1);
console.log(`v1.js güncellendi — ${n} uç korumaya alındı + chat kontrolü`);
