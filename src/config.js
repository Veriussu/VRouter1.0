module.exports = {
  PORT: parseInt(process.env.PORT || '10090', 10),
  HOST: process.env.HOST || '0.0.0.0',

  // Ana şifreleme anahtarı - provider API anahtarlarını şifrelemek için
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'vrouter-beta-default-key-change-me',

  MODELS_DEV_URL: process.env.MODELS_DEV_URL || 'https://models.dev/api.json?type=all',
  SYNC_INTERVAL_HOURS: parseInt(process.env.SYNC_INTERVAL_HOURS || '24', 10),

  // Token sıkıştırma
  COMPRESSION_ENABLED: process.env.COMPRESSION_ENABLED !== 'false',
  COMPRESSION_THRESHOLD: parseInt(process.env.COMPRESSION_THRESHOLD || '2000', 10),

  MAX_REQUEST_BODY: process.env.MAX_REQUEST_BODY || '25mb',
  REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || '600000', 10),
};
