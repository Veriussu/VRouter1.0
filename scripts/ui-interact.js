/**
 * Chrome DevTools Protocol ile arayüz etkileşimi doğrulama.
 * Butona tıklar, ekran görüntüsü alır, konsol hatalarını raporlar.
 *
 * Kullanım: node scripts/ui-interact.js "<url>" "<tıklama-js>" <çıktı-adı>
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');

const URL_TARGET = process.argv[2] || 'http://localhost:10090/dashboard/?page=providers';
const CLICK_JS = process.argv[3] || `document.querySelector('[data-act="add"]').click()`;
const OUT_NAME = process.argv[4] || 'modal';
const OUT = '/tmp/vrouter-ui';
const PORT = 9333;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Eski chrome kalıntılarını temizle
  try { execSync(`pkill -f "remote-debugging-port=${PORT}"`, { stdio: 'ignore' }); } catch { /* yok */ }

  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1400,1050',
    '--user-data-dir=/tmp/chrome-vrouter-profile',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    // Hata ayıklama uç noktası hazır olana kadar bekle
    let target = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_TARGET)}`, { method: 'PUT' });
        target = await r.json();
        if (target.webSocketDebuggerUrl) break;
      } catch { /* henüz hazır değil */ }
      await sleep(300);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('Chrome hata ayıklama uç noktasına bağlanılamadı');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('WebSocket bağlantısı başarısız'));
    });

    let id = 0;
    const pending = new Map();
    const consoleErrors = [];

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
      }
    };

    const send = (method, params = {}) =>
      new Promise((res) => {
        const msgId = ++id;
        pending.set(msgId, res);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });

    await send('Runtime.enable');
    await send('Page.enable');

    // Sayfayı yükle
    await send('Page.navigate', { url: URL_TARGET });
    await sleep(3000);

    // Etkileşimi uygula
    const clickRes = await send('Runtime.evaluate', { expression: CLICK_JS, awaitPromise: true, returnByValue: true });
    if (clickRes.result?.exceptionDetails) {
      console.error('tıklama betiği hatası:', clickRes.result.exceptionDetails.exception?.description);
    }
    await sleep(1200);

    // Ekran görüntüsü
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = `${OUT}/${OUT_NAME}.png`;
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log('görüntü:', file, `(${fs.statSync(file).size} bayt)`);

    // Modal açık mı / ne var
    const probe = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        modalOpen: document.getElementById('modalBackdrop').classList.contains('open'),
        modalTitle: document.getElementById('modalTitle')?.textContent,
        options: document.querySelectorAll('.sp-opt').length,
        keyFormVisible: document.getElementById('spKeyForm')?.style.display !== 'none',
        rows: document.querySelectorAll('#provBody tr').length
      })`,
      returnByValue: true,
    });
    console.log('durum:', probe.result.result.value);

    if (consoleErrors.length) {
      console.log('\nkonsol hataları:');
      consoleErrors.forEach((e) => console.log('  ✗', String(e).split('\n')[0]));
    } else {
      console.log('konsol hataları: yok');
    }
  } finally {
    if (ws) ws.close();
    chrome.kill();
    try { execSync(`rm -rf /tmp/chrome-vrouter-profile`, { stdio: 'ignore' }); } catch { /* yoksay */ }
  }
}

main().catch((e) => { console.error('hata:', e.message); process.exit(1); });
