/**
 * Headless Chrome ile panelin gerçekten render edildiğini doğrular.
 */
const { execSync } = require('child_process');
const fs = require('fs');

const OUT = '/tmp/vrouter-ui';
fs.mkdirSync(OUT, { recursive: true });
const url = process.argv[2] || 'http://localhost:10090/dashboard/';

async function main() {
  try {
    execSync(
      `google-chrome --headless --disable-gpu --no-sandbox --disable-dev-shm-usage ` +
        `--virtual-time-budget=6000 --window-size=1400,1000 ` +
        `--screenshot=${OUT}/dashboard.png "${url}"`,
      { stdio: 'pipe', timeout: 60000 }
    );
    const size = fs.statSync(`${OUT}/dashboard.png`).size;
    console.log(`ekran görüntüsü: ${OUT}/dashboard.png (${size} bayt${size > 10000 ? ', içerik var' : ', ŞÜPHELİ'})`);
  } catch (err) {
    console.error('chrome hatası:', (err.stderr?.toString() || err.message).slice(0, 300));
  }

  const html = await (await fetch(url)).text();
  const js = await (await fetch('http://localhost:10090/app.js')).text();

  const checks = [
    ['panel başlığı', html.includes('VRouter — Panel')],
    ['sağlayıcılar sekmesi', html.includes('data-page="providers"')],
    ['modal iskeleti', html.includes('modalBackdrop')],
    ['app.js spList (sağlayıcı listesi)', js.includes('spList')],
    ['app.js spKeyForm (api key alanı)', js.includes('spKeyForm')],
    ['app.js provWrap (sarmalayıcı)', js.includes('provWrap')],
    ['app.js openAddProviderModal', js.includes('openAddProviderModal')],
    ['app.js hasActiveKey filtresi', js.includes('hasActiveKey')],
  ];

  console.log('\nSayfa yapısı:');
  for (const [n, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${n}`);

  const bad = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${bad === 0 ? '✓ Hepsi doğrulandı' : `✗ ${bad} sorun`}`);
  process.exit(bad ? 1 : 0);
}

main();
