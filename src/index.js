const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');

const config = require('./config');
const { db, setSetting } = require('./db');
const providerSvc = require('./services/providers');
const syncSvc = require('./services/sync');
const rotator = require('./services/keyRotator');

const app = express();

// Beklenmeyen hatalar sunucuyu düşürmesin
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err.message, '\n', err.stack?.split('\n').slice(1, 4).join('\n'));
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err?.message || err);
});

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors());
app.use(compression());
app.use(express.json({ limit: config.MAX_REQUEST_BODY }));

// İstek günlüğü
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/admin')) return;
    console.log(`${res.statusCode} ${req.method} ${req.originalUrl} ${Date.now() - t}ms`);
  });
  next();
});

// Sağlık kontrolü
app.get('/health', (req, res) => {
  const counts = {
    providers: db.prepare('SELECT COUNT(*) n FROM providers').get().n,
    models: db.prepare('SELECT COUNT(*) n FROM models').get().n,
    api_keys: db.prepare('SELECT COUNT(*) n FROM api_keys').get().n,
  };
  res.json({ status: 'ok', version: '0.1.0-beta', uptime: Math.round(process.uptime()), counts });
});

// Ana meta uç
app.get('/', (req, res) => res.redirect('/dashboard/'));
app.get('/v1', (req, res) =>
  res.json({
    name: 'VRouter',
    version: '0.1.0-beta',
    endpoints: [
      'GET  /v1/models',
      'GET  /v1/models/categories',
      'GET  /v1/models/:id',
      'POST /v1/chat/completions',
      'POST /v1/completions',
      'POST /v1/embeddings',
      'POST /v1/images/generations',
      'POST /v1/audio/speech',
      'POST /v1/audio/transcriptions',
    ],
    categories: ['chat', 'vision', 'image', 'tts', 'transcription', 'audio', 'embedding', 'reasoning', 'planning', 'video', 'code', 'pdf'],
  })
);

// API rotaları
app.use('/v1', require('./routes/v1'));
app.use('/admin/api', require('./routes/admin'));

// Arayüz
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Express varsayılan olarak '/dashboard' rotasını '/dashboard/' ile de eşleştirir;
// bu yüzden yalnızca tam eşleşmeyi yönlendiriyoruz (aksi halde döngü oluşur).
app.use((req, res, next) => {
  if (req.path === '/dashboard') return res.redirect(301, '/dashboard/');
  next();
});
app.use('/dashboard', express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use(express.static(PUBLIC_DIR));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/admin/api')) return res.status(404).json({ error: 'Bilinmeyen yönetim uç noktası' });
  if (req.path.startsWith('/v1')) return res.status(404).json({ error: { type: 'invalid_request_error', message: 'Bilinmeyen uç nokta' } });
  res.status(404).sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Hata yakalayıcı
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return;
  const status = err.type === 'entity.too.large' ? 413 : 500;
  res.status(status).json({ error: { type: 'api_error', message: err.message } });
});

/* ----------------------------- başlatma ----------------------------- */

async function bootstrap() {
  providerSvc.ensureBuiltins();

  const providerCount = db.prepare('SELECT COUNT(*) n FROM providers').get().n;
  const modelCount = db.prepare('SELECT COUNT(*) n FROM models').get().n;

  if (modelCount === 0) {
    console.log('[boot] models.dev senkronizasyonu başlatılıyor...');
    try {
      const r = await syncSvc.syncFromModelsDev();
      setSetting('last_sync', new Date().toISOString());
      setSetting('sync_source', 'models.dev');
      console.log(`[boot] ${r.providers} sağlayıcı, ${r.models} model yüklendi`);
    } catch (err) {
      console.error('[boot] senkronizasyon başarısız:', err.message);
      setSetting('last_sync_error', err.message);
    }
  } else {
    console.log(`[boot] mevcut veri: ${providerCount} sağlayıcı, ${modelCount} model`);
  }

  // Soğuyan anahtarları periyodik olarak geri getir
  setInterval(() => {
    const n = rotator.reviveCooldowns();
    if (n) console.log(`[maintenance] ${n} anahtar yeniden aktifleştirildi`);
  }, 60000).unref();

  // Günlük senkronizasyon
  const intervalMs = Math.max(1, config.SYNC_INTERVAL_HOURS) * 3600 * 1000;
  setInterval(async () => {
    try {
      const r = await syncSvc.syncFromModelsDev();
      setSetting('last_sync', new Date().toISOString());
      setSetting('last_sync_error', '');
      console.log(`[sync] tamamlandı: ${r.providers} sağlayıcı, ${r.models} model`);
    } catch (err) {
      console.error('[sync] hata:', err.message);
      setSetting('last_sync_error', err.message);
    }
  }, intervalMs).unref();

  app.listen(config.PORT, config.HOST, () => {
    console.log('');
    console.log('  VRouter 0.1.0-beta');
    console.log(`  ├─ Arayüz   http://localhost:${config.PORT}/dashboard`);
    console.log(`  ├─ API      http://localhost:${config.PORT}/v1`);
    console.log(`  └─ Yönetim  http://localhost:${config.PORT}/admin/api/stats`);
    console.log('');
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('Başlatma hatası:', err);
    process.exit(1);
  });
}

module.exports = { app, bootstrap };
