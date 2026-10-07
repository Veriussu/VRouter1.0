#!/usr/bin/env node
require('dotenv').config();
const providerSvc = require('../src/services/providers');
const syncSvc = require('../src/services/sync');
const { db } = require('../src/db');
const { setSetting } = require('../src/db');

(async () => {
  providerSvc.ensureBuiltins();
  console.log('models.dev senkronize ediliyor...');
  try {
    const r = await syncSvc.syncFromModelsDev();
    setSetting('last_sync', new Date().toISOString());
    setSetting('last_sync_error', '');
    console.log(`Tamam: ${r.providers} sağlayıcı, ${r.models} model`);

    const cats = db
      .prepare(`SELECT categories FROM models WHERE is_active = 1`)
      .all()
      .flatMap((r) => JSON.parse(r.categories));
    const counts = new Map();
    cats.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
    console.log('\nKategoriler:');
    [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c.padEnd(20)} ${n}`));
  } catch (err) {
    setSetting('last_sync_error', err.message);
    console.error('Hata:', err.message);
    process.exit(1);
  }
})();
