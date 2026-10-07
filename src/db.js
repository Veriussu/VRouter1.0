const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'vrouter.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  base_url     TEXT NOT NULL,
  api_format   TEXT NOT NULL DEFAULT 'openai',
  logo_url     TEXT,
  docs_url     TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  metadata     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_api_keys (
  id                    TEXT PRIMARY KEY,
  provider_id           TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  key_encrypted         TEXT NOT NULL,
  key_hash              TEXT NOT NULL,
  key_mask              TEXT NOT NULL,
  key_name              TEXT,
  priority              INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',
  usage_count           INTEGER NOT NULL DEFAULT 0,
  error_count           INTEGER NOT NULL DEFAULT 0,
  rate_limit_reset_at   TEXT,
  cooldown_until        TEXT,
  last_used_at          TEXT,
  last_error            TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_keys_provider ON provider_api_keys(provider_id, status);

CREATE TABLE IF NOT EXISTS models (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  original_name   TEXT NOT NULL,
  alias           TEXT,
  display_name    TEXT,
  categories      TEXT NOT NULL DEFAULT '[]',
  capabilities    TEXT NOT NULL DEFAULT '[]',
  description     TEXT,
  context_length  INTEGER,
  max_output      INTEGER,
  modality_in     TEXT,
  modality_out    TEXT,
  pricing         TEXT,
  release_date    TEXT,
  is_active       INTEGER NOT NULL DEFAULT 0,
  is_available    INTEGER NOT NULL DEFAULT 0,
  last_synced_at  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider_id, original_name)
);
CREATE INDEX IF NOT EXISTS idx_models_active ON models(is_active);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  description   TEXT,
  model_scope   TEXT NOT NULL DEFAULT '*',
  rate_limit    INTEGER,
  daily_token_limit   INTEGER,
  daily_request_limit INTEGER,
  valid_from    TEXT,
  valid_until   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);

CREATE TABLE IF NOT EXISTS request_logs (
  id                TEXT PRIMARY KEY,
  api_key_id        TEXT,
  provider_id       TEXT,
  provider_key_id   TEXT,
  model_id          TEXT,
  requested_model   TEXT,
  endpoint          TEXT,
  category          TEXT,
  stream            INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost              REAL NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  status            TEXT NOT NULL,
  status_code       INTEGER,
  error_message     TEXT,
  compressed        INTEGER NOT NULL DEFAULT 0,
  saved_tokens      INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 1,
  client_ip         TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_apikey  ON request_logs(api_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

/* --------------------------- göçler --------------------------- */
// Mevcut veritabanlarına yeni sütun eklemek için.
// CREATE TABLE IF NOT EXISTS çalışan DB'lerde sütun eklemez.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] göç: ${table}.${column} eklendi`);
  }
}

// Yumuşak silme: silinen sağlayıcı kaydı kalır, geri getirilebilir.
ensureColumn('providers', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('request_logs', 'usage_known', 'INTEGER NOT NULL DEFAULT 0');
db.prepare('UPDATE request_logs SET usage_known = 1 WHERE usage_known = 0 AND total_tokens > 0').run();

// Model kataloğu ile panelde/API'de etkinleştirilen modelleri ayır.
// Eski kurulumlarda tüm katalog modelleri varsayılan olarak aktifti; geçişi
// yalnızca bir kez yapıp katalog kayıtlarını koruyoruz.
const modelSelectionInitialized = db
  .prepare("SELECT value FROM settings WHERE key = 'model_selection_initialized'")
  .get();
if (!modelSelectionInitialized) {
  db.prepare('UPDATE models SET is_active = 0').run();
  db.prepare(
    "INSERT INTO settings(key, value) VALUES('model_selection_initialized', datetime('now'))"
  ).run();
}

const getSetting = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
};

const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);

module.exports = { db, getSetting, setSetting, DATA_DIR };
