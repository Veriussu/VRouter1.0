#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// Keep runtime state outside the repository so updates never touch it.
const PID_FILE = process.env.VROUTER_PID_FILE || '/tmp/vrouter.pid';
const LOG_FILE = process.env.VROUTER_LOG_FILE || '/tmp/vrouter.log';

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function running(pid = readPid()) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch { /* zaten yok */ }
}

function start() {
  const oldPid = readPid();
  if (running(oldPid)) {
    console.log(`VRouter zaten çalışıyor (pid ${oldPid})`);
    return;
  }
  removePid();

  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  fs.writeFileSync(PID_FILE, `${child.pid}\n`);
  child.unref();
  console.log(`VRouter arka planda başlatıldı (pid ${child.pid})`);
  console.log(`Log: ${LOG_FILE}`);
}

function stop() {
  const pid = readPid();
  if (!pid || !running(pid)) {
    removePid();
    console.log('VRouter zaten durmuş.');
    return;
  }

  try { process.kill(pid, 'SIGTERM'); } catch { /* süreç kapanmış olabilir */ }
  const deadline = Date.now() + 5000;
  while (running(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (running(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* yok */ }
  }
  removePid();
  console.log(`VRouter durduruldu (pid ${pid})`);
}

function reboot() {
  stop();
  start();
}

function update() {
  const wasRunning = running();
  if (wasRunning) stop();
  let exitCode = 0;
  try {
    const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, encoding: 'utf8' });
    if (pull.status !== 0) {
      process.stderr.write(pull.stderr || pull.stdout || 'Git güncellemesi başarısız\n');
      exitCode = pull.status || 1;
    } else {
      process.stdout.write(pull.stdout || '');
      const install = spawnSync('npm', ['install', '--omit=dev'], { cwd: ROOT, stdio: 'inherit' });
      exitCode = install.status || 0;
    }
  } finally {
    if (wasRunning) start();
  }
  if (exitCode === 0) console.log('VRouter güncellendi.');
  process.exitCode = exitCode;
}

function clear() {
  const { db } = require(path.join(ROOT, 'src/db'));
  const logs = db.prepare('DELETE FROM request_logs').run().changes;
  const keys = db.prepare(
    `UPDATE provider_api_keys
     SET status = CASE WHEN status IN ('cooldown', 'invalid') THEN 'active' ELSE status END,
         cooldown_until = NULL, rate_limit_reset_at = NULL, error_count = 0, last_error = NULL`
  ).run().changes;
  console.log(`${logs} istek logu temizlendi, ${keys} sağlayıcı anahtarı sıfırlandı.`);
  console.log('Sağlayıcılar, modeller ve anahtar kayıtları korunmuştur.');
}

function help() {
  console.log(`VRouter CLI\n\nKullanım:\n  vrouter start    Arka planda başlat\n  vrouter stop     Durdur\n  vrouter reboot   Yeniden başlat\n  vrouter update   GitHub'dan güncelle ve bağımlılıkları kur\n  vrouter clear    İstek loglarını temizle, anahtar cooldown durumlarını sıfırla\n`);
}

const command = process.argv[2];
switch (command) {
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'reboot': reboot(); break;
  case 'update': update(); break;
  case 'clear': clear(); break;
  case 'help':
  case '--help':
  case '-h':
  default: help(); if (command && command !== 'help' && command !== '--help' && command !== '-h') process.exitCode = 1;
}
