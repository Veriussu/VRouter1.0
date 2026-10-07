/**
 * Tüm panel sayfalarını headless Chrome ile render kontrolü.
 * Her sayfa için: konsol hatası, hata kartı, tablo satır sayısı.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');

const PAGES = ['dashboard', 'providers', 'keys', 'models', 'apikeys', 'logs'];
const PORT = 9334;
const OUT = '/tmp/vrouter-ui';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  try { execSync(`pkill -f "remote-debugging-port=${PORT}"`, { stdio: 'ignore' }); } catch {}

  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, '--window-size=1400,1050',
    '--user-data-dir=/tmp/chrome-vrouter-pages', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let target = null;
    for (let i = 0; i < 40 && !target?.webSocketDebuggerUrl; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
        target = await r.json();
      } catch {}
      if (!target?.webSocketDebuggerUrl) await sleep(300);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('Chrome bağlantısı kurulamadı');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws hatası')); });

    let id = 0;
    const pending = new Map();
    let errors = [];

    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] || m.params.exceptionDetails.text);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push(m.params.args.map((a) => a.value || a.description).join(' ').split('\n')[0]);
      }
    };

    const send = (method, params = {}) =>
      new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

    await send('Runtime.enable');
    await send('Page.enable');

    let failed = 0;

    for (const page of PAGES) {
      errors = [];
      await send('Page.navigate', { url: `http://localhost:10090/dashboard/?page=${page}` });
      await sleep(2500);

      const probe = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          title: document.getElementById('pageTitle')?.textContent,
          errCard: document.querySelector('#content .empty-icon')?.textContent === '⚠️'
                    ? document.querySelector('#content .empty').textContent.trim() : null,
          rows: document.querySelectorAll('#content tbody tr').length,
          spinner: !!document.querySelector('#content .spinner'),
          buttons: document.querySelectorAll('#content button[data-act]').length
        })`,
        returnByValue: true,
      });

      const d = JSON.parse(probe.result.result.value);
      const bad = d.errCard || errors.length || d.spinner;
      if (bad) failed++;

      const mark = bad ? '✗' : '✓';
      console.log(`  ${mark} ${page.padEnd(11)} başlık="${d.title}" satır=${String(d.rows).padStart(4)} buton=${String(d.buttons).padStart(2)}` +
        (d.errCard ? ` HATA: ${d.errCard.slice(0, 70)}` : '') +
        (errors.length ? ` JS: ${errors[0].slice(0, 70)}` : '') +
        (d.spinner ? ' [yükleniyor-kaldı]' : ''));
    }

    // silme onayı her sayfada var mı?
    console.log('\n  Silme onayı kontrolü:');
    for (const [page, sel] of [['keys', '#keyTableBody [data-act="del"]'], ['apikeys', '#apiKeyWrap [data-act="del"]']]) {
      await send('Page.navigate', { url: `http://localhost:10090/dashboard/?page=${page}` });
      await sleep(2200);
      const r = await send('Runtime.evaluate', {
        expression: `(function(){
          const b = document.querySelector('${sel}');
          if (!b) return JSON.stringify({ found: false });
          b.click();
          return JSON.stringify({ found: true });
        })()`,
        returnByValue: true,
      });
      const clicked = JSON.parse(r.result.result.value);
      await sleep(700);
      const p2 = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          open: document.getElementById('modalBackdrop').classList.contains('open'),
          title: document.getElementById('modalTitle').textContent,
          hasIcon: !!document.querySelector('.confirm-icon'),
          hasOk: !!document.getElementById('confirmOk'),
          hasCancel: !!document.querySelector('#modalFoot [data-close]')
        })`,
        returnByValue: true,
      });
      const d = JSON.parse(p2.result.result.value);
      const ok = clicked.found && d.open && d.hasIcon && d.hasOk && d.hasCancel;
      if (!ok) failed++;
      console.log(`    ${ok ? '✓' : '✗'} ${page.padEnd(11)} "${d.title}" ikon=${d.hasIcon} onay=${d.hasOk} iptal=${d.hasCancel}`);
    }

    console.log(failed ? `\n  ✗ ${failed} sorun` : '\n  ✓ Tüm sayfalar sorunsuz');
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (ws) ws.close();
    chrome.kill();
    try { execSync('rm -rf /tmp/chrome-vrouter-pages', { stdio: 'ignore' }); } catch {}
  }
}

main().catch((e) => { console.error('hata:', e.message); process.exit(1); });
