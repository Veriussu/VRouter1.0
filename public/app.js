/* VRouter Paneli */
'use strict';

const api = {
  async get(path) {
    const r = await fetch(`/admin/api${path}`);
    if (r.status === 401) { window.location.reload(); throw new Error('Oturum süresi doldu'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, path, body) {
    const r = await fetch(`/admin/api${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { window.location.reload(); throw new Error('Oturum süresi doldu'); }
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const content = $('#content');
const state = { models: [], providers: [], categories: [] };
let authUser = null;

/* ------------------------------- yardımcılar ------------------------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

const fmtMoney = (n) => '$' + Number(n || 0).toFixed(Number(n) >= 1 ? 2 : 4);
const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T') + (s.length === 19 ? 'Z' : '')).toLocaleString('tr-TR') : '—');

function timeAgo(s) {
  if (!s) return '—';
  const diff = (Date.now() - new Date(String(s).replace(' ', 'T') + 'Z').getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)} sn önce`;
  if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa önce`;
  return `${Math.floor(diff / 86400)} gün önce`;
}

function tags(list) {
  return (list || [])
    .map((c) => `<span class="tag tag-${esc(c)}">${esc(c)}</span>`)
    .join('');
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 250);
  }, 3800);
}

/* -------------------------------- kimlik -------------------------------- */

async function authFetch(path, body) {
  const r = await fetch(`/admin/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function renderAuth(setup) {
  document.body.classList.add('auth-screen');
  $('#serverBadge').textContent = 'giriş gerekli';
  $('#serverBadge').className = 'badge';
  content.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand"><span class="brand-mark">VR</span><div><div class="brand-name">VRouter</div><div class="brand-version">Yönetim Paneli</div></div></div>
        <h1>${setup ? 'İlk kurulumu tamamlayın' : 'Tekrar hoş geldiniz'}</h1>
        <p class="auth-subtitle">${setup ? 'Panel için bir yönetici hesabı oluşturun.' : 'Devam etmek için giriş yapın.'}</p>
        <form id="authForm">
          <div class="field"><label for="authUsername">Kullanıcı adı</label><input class="input" id="authUsername" autocomplete="username" required minlength="3" autofocus></div>
          <div class="field"><label for="authPassword">Şifre</label><input class="input" id="authPassword" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="6"></div>
          <div class="auth-error" id="authError"></div>
          <button class="btn btn-primary btn-block" id="authSubmit" type="submit">${setup ? 'Hesap oluştur' : 'Giriş yap'}</button>
        </form>
        <div class="auth-note">VRouter · veriussu.com</div>
      </div>
    </div>`;
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('#authSubmit');
    const error = $('#authError');
    button.disabled = true;
    error.textContent = '';
    try {
      const body = { username: $('#authUsername').value.trim(), password: $('#authPassword').value };
      await authFetch(setup ? '/register' : '/login', body);
      window.location.reload();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}

async function initAuth() {
  try {
    const r = await fetch('/admin/api/auth/status');
    const status = await r.json();
    if (!status.authenticated) return renderAuth(status.setup_required);
    authUser = status.username;
    document.body.classList.remove('auth-screen');
    navigate(initialPage(), false);
  } catch {
    renderAuth(false);
  }
}

/* ------------------------------ modal yığını ------------------------------ */
/**
 * Katman listesi. Onay diyaloğu, açık modalın ÜSTÜNE açılabilsin diye
 * tek bir backdrop yerine yığına ihtiyaç duyuyoruz.
 */
const modalStack = [];

function renderModalLayer() {
  const backdrop = $('#modalBackdrop');
  const top = modalStack[modalStack.length - 1];

  if (!top) {
    backdrop.classList.remove('open', 'warn');
    return;
  }

  $('#modalTitle').textContent = top.title;
  $('#modalBody').innerHTML = top.body;
  $('#modalFoot').innerHTML = top.foot || '<button class="btn" data-close>Kapat</button>';
  backdrop.classList.add('open');
  backdrop.classList.toggle('warn', !!top.warn);
  top.onRender?.();
}

/**
 * @param {object} hooks
 * @param {Function} [hooks.onRender] her yeniden çizimde çağrılır (dinleyici bağla)
 * @param {Function} [hooks.onClose]   katman kapanırken çağrılır
 * @param {boolean}  [hooks.replace]   üstteki katmanın yerine geç
 * @param {boolean}  [hooks.warn]      uyarı görünümü
 */
function openModal(title, bodyHtml, footHtml, hooks = {}) {
  const layer = { title, body: bodyHtml, foot: footHtml, ...hooks };

  if (hooks.replace && modalStack.length) modalStack[modalStack.length - 1] = layer;
  else modalStack.push(layer);

  renderModalLayer();
  return layer;
}

function closeModal() {
  const top = modalStack.pop();
  top?.onClose?.();
  renderModalLayer();
}

/* ---------------------------- onay diyaloğu ---------------------------- */

/**
 * Tasarımla uyumlu silme onayı. Promise<boolean> döner.
 *   Enter → onay, Esc / arka plan / iptal → vazgeç
 */
function confirmDialog({
  title = 'Silmek istediğinize emin misiniz?',
  message = 'Bu işlem geri alınamaz.',
  subject = "",
  confirmText = 'Sil',
  cancelText = 'Vazgeç',
  icon = '🗑️',
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onEnter);
      resolve(value);
    };
    const onEnter = (e) => {
      if (e.key === 'Enter' && !settled) {
        e.preventDefault();
        finish(true);
        closeModal();
      }
    };

    openModal(
      title,
      `<div class="confirm-body">
        <div class="confirm-icon">${icon}</div>
        <div class="confirm-text">
          ${message}${subject ? `<div style="margin-top:8px"><strong>${subject}</strong></div>` : ""}
        </div>
      </div>`,
      `<button class="btn" data-close>${cancelText}</button>
       <button class="btn btn-danger-solid" id="confirmOk">${confirmText}</button>`,
      {
        warn: true,
        onRender: () => {
          $('#confirmOk')?.addEventListener('click', () => {
            finish(true);
            closeModal();
          });
          $('#confirmOk')?.focus();
        },
        onClose: () => finish(false),
      }
    );

    document.addEventListener('keydown', onEnter);
  });
}

/* --------------------------------- sayfalar --------------------------------- */

const PAGES = {
  async dashboard() {
    const s = await api.get('/stats');
    const c = s.counts;
    const sum = s.summary || {};

    const successRate = sum.requests ? ((sum.success || 0) / sum.requests) * 100 : 0;
    const compressionRate = sum.input_tokens + sum.saved_tokens > 0
      ? (sum.saved_tokens / (sum.input_tokens + sum.saved_tokens)) * 100
      : 0;

    content.innerHTML = `
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="stat"><div class="stat-label">İstekler (24s)</div>
          <div class="stat-value">${fmtNum(sum.requests)}</div>
          <div class="stat-sub">${successRate.toFixed(1)}% başarılı</div></div>
        <div class="stat"><div class="stat-label">Token (24s)</div>
          <div class="stat-value">${fmtNum(sum.total_tokens)}</div>
          <div class="stat-sub">${fmtNum(sum.input_tokens)} giriş · ${fmtNum(sum.output_tokens)} çıkış · ${fmtNum(sum.saved_tokens)} tasarruf</div></div>
        <div class="stat"><div class="stat-label">Maliyet (24s)</div>
          <div class="stat-value">${fmtMoney(sum.cost)}</div>
          <div class="stat-sub">${compressionRate.toFixed(1)}% sıkıştırma</div></div>
        <div class="stat"><div class="stat-label">Ort. Gecikme</div>
          <div class="stat-value">${Math.round(sum.avg_latency || 0)}<span style="font-size:15px"> ms</span></div>
          <div class="stat-sub">${c.healthy_keys}/${c.provider_keys} anahtar sağlıklı</div></div>
      </div>

      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="stat"><div class="stat-label">Sağlayıcı</div><div class="stat-value">${c.active_providers}<span class="muted" style="font-size:15px"> / ${c.providers}</span></div><div class="stat-sub">aktif / toplam</div></div>
        <div class="stat"><div class="stat-label">Etkin Model</div><div class="stat-value">${fmtNum(c.models)}</div><div class="stat-sub">${fmtNum(c.catalog_models ?? c.available_models)} keşfedildi</div></div>
        <div class="stat"><div class="stat-label">İstemci Anahtarı</div><div class="stat-value">${c.api_keys}</div><div class="stat-sub">oluşturulmuş API</div></div>
        <div class="stat"><div class="stat-label">Kategori</div><div class="stat-value">${(s.categories || []).length}</div><div class="stat-sub">farklı kategori</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>İşlem Hacmi</h2><span class="muted small">son 24 saat</span></div>
        <div class="card-body">${renderTimeline(s.timeline || [])}</div>
      </div>

      <div class="grid grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
        <div class="card"><div class="card-head"><h2>Sağlayıcı Dağılımı</h2></div>
          <div class="card-body">${renderBars(s.byProvider || [], 'provider', 'requests')}</div></div>
        <div class="card"><div class="card-head"><h2>En Çok Kullanılan Modeller</h2></div>
          <div class="card-body">${renderBars(s.byModel || [], 'model', 'requests')}</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Kategoriler</h2><span class="muted small">model sayısına göre</span></div>
        <div class="card-body">${renderCategoryGrid(s.categories || [])}</div>
      </div>`;
  },

  async providers() {
    const { data } = await api.get('/providers');
    state.providers = data;
    renderProviders();
  },
  async keys() {
    const { data } = await api.get('/keys');
    const pName = (slug) => (state.providers.find((p) => p.slug === slug)?.name || slug);

    const rows = data
      .map(
        (k) => `<tr>
        <td><div style="font-weight:550">${esc(pName(k.provider_slug))}</div><div class="mono muted" style="font-size:11.5px">${esc(k.provider_slug)}</div></td>
        <td>${esc(k.key_name || '—')}</td>
        <td class="mono">${esc(k.key_mask)}</td>
        <td class="num">${k.priority}</td>
        <td><span class="pill pill-${esc(k.status)}">${esc(k.status)}</span>
          ${k.cooldown_until ? `<div class="muted small">${timeAgo(k.cooldown_until)}</div>` : ''}</td>
        <td class="num">${fmtNum(k.usage_count)}</td>
        <td class="num">${k.error_count || 0}</td>
        <td class="small muted">${timeAgo(k.last_used_at)}</td>
        <td class="num">
          ${k.status !== 'active' && k.status !== 'disabled'
            ? `<button class="btn btn-sm" data-act="enable" data-id="${k.id}">Aktifleştir</button>` : ''}
          <button class="btn btn-sm btn-danger" data-act="del" data-id="${k.id}">Sil</button>
        </td></tr>`
      )
      .join('');

    content.innerHTML = `
      <div class="card"><div class="card-head">
        <h2>Sağlayıcı API Anahtarları</h2>
        <span class="muted small">${data.length} anahtar</span>
      </div><div class="table-wrap">
        <table><thead><tr>
          <th>Sağlayıcı</th><th>Etiket</th><th>Anahtar</th><th class="num">Öncelik</th>
          <th>Durum</th><th class="num">Kullanım</th><th class="num">Hata</th><th>Son Kullanım</th><th class="num"></th>
        </tr></thead><tbody id="keyTableBody">${rows || '<tr><td colspan="9" class="empty">Henüz anahtar eklenmedi</td></tr>'}</tbody></table>
      </div></div>`;

    $('#keyTableBody').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'del') {
        const row = data.find((k) => k.id === btn.dataset.id);
        const ok = await confirmDialog({
          title: 'API anahtarı silinsin mi?',
          message: 'Bu anahtar sağlayıcıya yapılan isteklerde kullanılamaz ve kaldırılamaz.',
          subject: `${row?.key_name || 'Anahtar'} · ${row?.key_mask || ''}`,
          confirmText: 'Anahtarı Sil',
        });
        if (!ok) return;
        await api.send('DELETE', `/keys/${btn.dataset.id}`);
        toast('Anahtar silindi', 'success');
        this.render();
      }
      if (btn.dataset.act === 'enable') {
        await api.send('PATCH', `/keys/${btn.dataset.id}`, { status: 'active' });
        toast('Anahtar aktifleştirildi', 'success');
        this.render();
      }
    });
  },

  async models() {
    const [m, cats] = await Promise.all([api.get('/models?limit=3000'), api.get('/models/categories')]);
    state.models = m.data;
    state.categories = cats.data;

    const catOptions = state.categories
      .map((c) => `<option value="${esc(c.category)}">${esc(c.category)} (${c.count})</option>`)
      .join('');

    const rows = state.models
      .slice(0, 400)
      .map(
        (m) => `<tr data-id="${m.id}">
        <td><div style="font-weight:550">${esc(m.display_name || m.original_name)}</div>
          <div class="mono muted" style="font-size:11.5px">${esc(m.alias ? `alias: ${m.alias}` : m.original_name)}</div></td>
        <td class="muted small">${esc(m.provider_slug)}</td>
        <td>${tags(m.categories)}</td>
        <td class="num small">${m.context_length ? fmtNum(m.context_length) : '—'}</td>
        <td class="num small">${m.pricing?.input != null ? `$${m.pricing.input}` : '—'}</td>
        <td class="num small">${m.pricing?.output != null ? `$${m.pricing.output}` : '—'}</td>
        <td>${m.is_available ? '' : '<span class="tag">pasif</span>'}</td>
        <td class="num"><button class="btn btn-sm" data-act="edit">Düzenle</button>
          <button class="btn btn-sm btn-danger" data-act="remove">Kaldır</button></td>
      </tr>`
      )
      .join('');

    content.innerHTML = `
      <div class="toolbar">
        <input class="input grow" id="modelSearch" placeholder="Model ara (ad, takma ad, sağlayıcı)…">
        <select class="select" id="catFilter"><option value="">Tüm kategoriler</option>${catOptions}</select>
        <span class="muted small">${fmtNum(m.total)} model</span>
        <button class="btn btn-primary" id="addModelBtn">Model Ekle</button>
      </div>
      <div class="card"><div class="table-wrap">
        <table><thead><tr>
          <th>Model</th><th>Sağlayıcı</th><th>Kategoriler</th><th class="num">Bağlam</th>
          <th class="num">Giriş $</th><th class="num">Çıkış $</th><th>Durum</th><th class="num"></th>
        </tr></thead><tbody id="modelBody">${rows}</tbody></table>
      </div>
      <div class="empty" id="modelEmpty" style="display:none">Sonuç bulunamadı</div></div>`;

    const apply = () => {
      const q = $('#modelSearch').value.toLowerCase();
      const cat = $('#catFilter').value;
      let visible = 0;
      $$('#modelBody tr').forEach((tr) => {
        const txt = tr.textContent.toLowerCase();
        const hasCat = !cat || (cats.data.find((c) => c.category === cat)?.count >= 0 && tr.children[2].textContent.includes(cat));
        const ok = txt.includes(q) && hasCat;
        tr.style.display = ok ? '' : 'none';
        if (ok) visible++;
      });
      $('#modelEmpty').style.display = visible ? 'none' : 'block';
      $('#modelBody').style.display = visible ? '' : 'none';
    };

    $('#modelSearch').addEventListener('input', apply);
    $('#catFilter').addEventListener('change', apply);
    $('#addModelBtn').addEventListener('click', openAddModelModal);
    $('#modelBody').addEventListener('click', (e) => {
      const button = e.target.closest('button[data-act]');
      if (!button) return;
      const id = e.target.closest('tr').dataset.id;
      if (button.dataset.act === 'edit') editModel(id);
      if (button.dataset.act === 'remove') removeModel(id);
    });
  },

  async apikeys() {
    const [k, cats] = await Promise.all([api.get('/api-keys'), api.get('/models/categories')]);
    state.categories = cats.data;

    const rows = k.data
      .map((a) => {
        let scope = a.model_scope;
        let scopeLabel = 'tüm modeller';
        if (scope && scope !== '*') {
          try { scopeLabel = JSON.parse(scope).join(', '); } catch { /* bozuk */ }
        }
        const expired = a.valid_until && new Date(String(a.valid_until).replace(' ', 'T')) < new Date();
        return `<tr>
        <td><div style="font-weight:550">${esc(a.name)}</div>
          ${a.description ? `<div class="muted small">${esc(a.description)}</div>` : ''}</td>
        <td class="mono">${esc(a.key_prefix)}…</td>
        <td class="small muted" style="max-width:220px">${esc(scopeLabel)}</td>
        <td class="num small">${a.rate_limit || '—'}</td>
        <td class="num small">${fmtNum(a.daily_token_limit) === '0' ? '—' : fmtNum(a.daily_token_limit)}</td>
        <td class="num small">${fmtNum(a.requests_24h)}</td>
        <td class="num small">${fmtMoney(a.total_cost)}</td>
        <td class="small">${a.valid_until ? `<span class="tag" style="${expired ? 'color:var(--red)' : ''}">${esc(a.valid_until.slice(0, 10))}</span>` : '<span class="muted">süresiz</span>'}</td>
        <td>${a.is_active ? '<span class="pill pill-active">aktif</span>' : '<span class="pill pill-disabled">kapalı</span>'}</td>
        <td class="num" style="white-space:nowrap">
          <button class="btn btn-sm" data-act="edit">Düzenle</button>
          <button class="btn btn-sm btn-danger" data-act="del" data-id="${a.id}">Sil</button>
        </td></tr>`;
      })
      .join('');

    content.innerHTML = `
    <div id="apiKeyWrap">
      <div class="toolbar">
        <button class="btn btn-primary" data-act="add">+ API Anahtarı Oluştur</button>
        <span class="muted small">Oluşturduğunuz anahtar yalnızca bir kez gösterilir.</span>
      </div>
      <div class="card"><div class="table-wrap">
        <table><thead><tr>
          <th>Ad</th><th>Anahtar</th><th>Model Kapsamı</th><th class="num">Dk limit</th>
          <th class="num">Günlük token</th><th class="num">İstek (24s)</th><th class="num">Maliyet</th>
          <th>Bitiş</th><th>Durum</th><th class="num"></th>
        </tr></thead><tbody>${rows || '<tr><td colspan="10" class="empty">Henüz API anahtarı oluşturulmadı</td></tr>'}</tbody></table>
      </div></div>
    </div>`;

    $('#apiKeyWrap').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'add') editApiKey(null);
      if (btn.dataset.act === 'edit') editApiKey(btn.closest('tr'));
      if (btn.dataset.act === 'del') {
        const tr = btn.closest('tr');
        const row = state.apiKeys?.find((a) => a.id === btn.dataset.id);
        const ok = await confirmDialog({
          title: 'API anahtarı silinsin mi?',
          message: 'Bu anahtarı kullanan tüm istemciler anında erişim kaybeder. Kullanım geçmişi loglarda kalır.',
          subject: row?.name ? `${row.name} (${row.key_prefix}…)` : tr?.querySelector('td')?.textContent?.trim(),
          confirmText: 'Anahtarı Sil',
        });
        if (!ok) return;
        await api.send('DELETE', `/api-keys/${btn.dataset.id}`);
        toast('API anahtarı silindi', 'success');
        this.render();
      }
    });
  },

  async logs() {
  const data = await api.get('/logs?limit=150');
    const rows = data.rows
      .map(
        (l) => `<tr>
        <td class="small muted" style="white-space:nowrap">${esc(l.created_at)}</td>
        <td><span class="pill pill-${l.status === 'success' ? 'active' : 'invalid'}">${esc(l.status)}</span></td>
        <td class="small"><div class="mono">${esc(l.display_name || l.requested_model || '—')}</div>
          ${l.display_name && l.requested_model && l.display_name !== l.requested_model ? `<div class="mono muted" style="font-size:10px">istenen: ${esc(l.requested_model)}</div>` : ''}</td>
        <td class="small">${esc(l.provider_name || '—')}</td>
        <td class="mono small">${esc(l.key_mask || '—')}</td>
        <td class="small"><span class="tag">${esc(l.endpoint || l.category || '—')}</span></td>
        <td class="num small">${l.usage_known ? fmtNum(l.input_tokens) : '—'}</td>
        <td class="num small">${l.usage_known ? fmtNum(l.output_tokens) : '—'}</td>
        <td class="num small">${l.usage_known ? fmtNum(l.total_tokens) : '—'}</td>
        <td class="num small">${l.usage_known ? fmtMoney(l.cost) : '—'}</td>
        <td class="num small">${l.latency_ms ? l.latency_ms + ' ms' : '—'}</td>
        <td class="small">${l.saved_tokens ? `<span class="tag" style="color:var(--green)">-${fmtNum(l.saved_tokens)}</span>` : '—'}${l.attempts > 1 ? ` <span class="tag">${l.attempts} deneme</span>` : ''}</td>
        <td class="small muted" style="max-width:240px">${esc(l.error_message || '')}</td>
      </tr>`
      )
      .join('');

    content.innerHTML = `
      <div class="toolbar">
        <input class="input grow" id="logSearch" placeholder="Model veya hata ara…">
        <select class="select" id="logStatus">
          <option value="">Tüm durumlar</option><option value="success">Başarılı</option><option value="error">Hata</option>
        </select>
        <span class="muted small">${data.total} kayıt</span>
      </div>
      <div class="card"><div class="table-wrap">
        <table><thead><tr>
          <th>Zaman</th><th>Durum</th><th>Model</th><th>Sağlayıcı</th><th>Anahtar</th><th>Uç</th>
          <th class="num">Giriş</th><th class="num">Çıkış</th><th class="num">Toplam</th><th class="num">Maliyet</th><th class="num">Gecikme</th><th>Not</th><th>Hata</th>
        </tr></thead><tbody id="logBody">${rows || '<tr><td colspan="13" class="empty">Henüz istek yok</td></tr>'}</tbody></table>
      </div></div>`;

    const apply = () => {
      const q = $('#logSearch').value.toLowerCase();
      const st = $('#logStatus').value;
      $$('#logBody tr').forEach((tr) => {
        tr.style.display = (tr.textContent.toLowerCase().includes(q) && (!st || tr.children[1].textContent.includes(st))) ? '' : 'none';
      });
    };
    $('#logSearch').addEventListener('input', apply);
    $('#logStatus').addEventListener('change', apply);
  },
};

/* ------------------------------ görünüm parçaları ------------------------------ */

function renderTimeline(points) {
  if (!points.length) return '<div class="empty"><div class="empty-icon">📈</div>Henüz veri yok</div>';
  const max = Math.max(...points.map((p) => p.requests), 1);
  const W = 900;
  const H = 165;
  const step = W / Math.max(points.length - 1, 1);

  const line = points.map((p, i) => `${i * step},${H - (p.requests / max) * (H - 20) - 5}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5b8cff" stop-opacity=".35"/><stop offset="100%" stop-color="#5b8cff" stop-opacity="0"/>
      </linearGradient></defs>
      ${[0.25, 0.5, 0.75].map((f) => `<line x1="0" y1="${H * f}" x2="${W}" y2="${H * f}" stroke="#252c3b" stroke-width="1"/>`).join('')}
      <polygon points="${area}" fill="url(#g)"/>
      <polyline points="${line}" fill="none" stroke="#5b8cff" stroke-width="2" stroke-linejoin="round"/>
    </svg>
    <div class="chart-legend"><span><i style="background:#5b8cff"></i>istek</span></div>`;
}

function renderBars(rows, labelKey, valueKey) {
  if (!rows.length) return '<div class="empty" style="padding:26px">Henüz veri yok</div>';
  const max = Math.max(...rows.map((r) => r[valueKey] || 0), 1);
  return rows
    .map(
      (r) => `<div class="bar-row">
        <div class="bar-label" title="${esc(r[labelKey] || '')}">${esc(r[labelKey] || '—')}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((r[valueKey] || 0) / max) * 100}%"></div></div>
        <div class="bar-value">${fmtNum(r[valueKey])}</div>
      </div>`
    )
    .join('');
}

function renderCategoryGrid(cats) {
  if (!cats.length) return '<div class="empty" style="padding:26px">Kategori yok</div>';
  const max = Math.max(...cats.map((c) => c.count));
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:9px">
    ${cats
      .map(
        (c) => `<div class="stat" style="padding:11px 13px;cursor:pointer" data-cat="${esc(c.category)}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="tag tag-${esc(c.category)}">${esc(c.category)}</span>
        <span class="mono" style="font-size:13px">${fmtNum(c.count)}</span>
      </div>
      <div class="bar-track" style="margin-top:7px"><div class="bar-fill" style="width:${(c.count / max) * 100}%"></div></div>
    </div>`
      )
      .join('')}
  </div>`;
}

function filterTable(q, sel) {
  q = q.toLowerCase();
  $$(`${sel} tr`).forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
}

/* ------------------------------ modal işlemleri ------------------------------ */

/* --------------------------- sağlayıcı listesi --------------------------- */

/** Sağlayıcının en az bir kullanılabilir anahtarı var mı */
const hasActiveKey = (p) => (p?.key_state?.active || 0) > 0;

/** Sağlayıcılar sayfasını yeniden çizer */
function renderProviders() {
  const all = state.providers || [];
  const active = all.filter(hasActiveKey);
  const rest = all.filter((p) => !hasActiveKey(p));

  state.showInactive = state.showInactive === true;
  const shown = state.showInactive ? all : active;

  const rows = shown
    .map((p) => {
      const ks = p.key_state || {};
      const total = ks.total || 0;
      const healthy = ks.active || 0;
      const cls = total === 0 ? 'idle' : healthy > 0 ? 'active' : 'invalid';
      const label =
        total === 0 ? 'anahtar yok'
        : healthy > 0 ? `${healthy}/${total} aktif`
        : 'tümü soğutuldu';

      return `<tr data-slug="${esc(p.slug)}">
          <td>
            <div style="display:flex;align-items:center;gap:9px">
              <img src="${esc(p.logo_url || '')}" onerror="this.style.visibility='hidden'" style="width:20px;height:20px;border-radius:4px">
              <div style="min-width:0">
                <div style="font-weight:550">${esc(p.name)} ${p.is_builtin ? '<span class="tag">yerleşik</span>' : ''}</div>
                <div class="mono muted" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.base_url)}</div>
              </div>
            </div>
          </td>
          <td><span class="tag">${esc(p.api_format)}</span></td>
          <td class="num"><strong>${fmtNum(p.active_model_count)}</strong><span class="muted small"> / ${fmtNum(p.available_model_count)}</span></td>
          <td><span class="pill pill-${cls}">${label}</span></td>
          <td>${p.is_active ? '<span class="pill pill-active">aktif</span>' : '<span class="pill pill-disabled">pasif</span>'}</td>
          <td class="num" style="white-space:nowrap">
            <button class="btn btn-sm" data-act="keys">Anahtarlar</button>
            <button class="btn btn-sm" data-act="sync">Sync</button>
            <button class="btn btn-sm" data-act="edit">Düzenle</button>
            ${p.is_deleted ? `<button class="btn btn-sm" data-act="restore">Geri Al</button>` : `<button class="btn btn-sm btn-danger" data-act="del">Sil</button>`}
          </td>
        </tr>`;
    })
    .join('');

  const emptyMsg = state.showInactive
    ? '<div class="empty"><div class="empty-icon">🔌</div>Sağlayıcı yok</div>'
    : '<div class="empty"><div class="empty-icon">🔑</div><div style="font-weight:550;margin-bottom:5px">Aktif anahtarı olan sağlayıcı yok</div>' +
      '<div class="small">Sağlayıcı ekleyerek başlayın — API anahtarı girdiğinizde burada görünecek.</div>' +
      '<button class="btn btn-primary" style="margin-top:14px" data-act="add">+ Sağlayıcı Ekle</button></div>';

  content.innerHTML = `
    <div id="provWrap">
    <div class="toolbar">
      <input class="input grow" id="provSearch" placeholder="Sağlayıcı ara…" value="${esc(state.provQuery || '')}">
      ${rest.length ? `<button class="btn" data-act="toggle">${state.showInactive ? 'Sadece aktifler' : `Tümünü göster (${all.length})`}</button>` : ''}
      <button class="btn btn-primary" data-act="add">+ Sağlayıcı Ekle</button>
    </div>
    <div class="card">
      ${shown.length ? `<div class="table-wrap">
        <table><thead><tr>
          <th>Sağlayıcı</th><th>Format</th><th class="num">Model (ekli / keşfedilen)</th><th>Anahtar Durumu</th><th>Durum</th><th class="num">İşlem</th>
        </tr></thead><tbody id="provBody">${rows}</tbody></table>
      </div>` : emptyMsg}
    </div>
    </div>`;

  const search = $('#provSearch');
  search.addEventListener('input', (e) => {
    state.provQuery = e.target.value;
    filterTable(e.target.value, '#provBody');
  });
  if (state.provQuery) filterTable(state.provQuery, '#provBody');

  $('#provWrap').addEventListener('click', onProvidersClick);
}

/** Sağlayıcılar sayfasındaki butolar */
function onProvidersClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;

  if (btn.dataset.act === 'add') return openAddProviderModal();
  if (btn.dataset.act === 'toggle') {
    state.showInactive = !state.showInactive;
    return renderProviders();
  }

  const slug = btn.closest('tr')?.dataset.slug;
  if (!slug) return;
  if (btn.dataset.act === 'keys') providerKeys(slug);
  if (btn.dataset.act === 'sync') syncProvider(slug, btn);
  if (btn.dataset.act === 'edit') editProvider(slug);
  if (btn.dataset.act === 'del') openDeleteProviderModal(slug);
  if (btn.dataset.act === 'restore') restoreProvider(slug);
}

async function syncProvider(slug, button) {
  const provider = (state.providers || []).find((p) => p.slug === slug);
  if (!provider) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Sync…';
  try {
    const result = await api.send('POST', `/providers/${slug}/sync-models`);
    const count = result.data?.count || 0;
    toast(`${provider.name}: ${count} model güncellendi`, 'success');
    const refreshed = await api.get('/providers');
    state.providers = refreshed.data;
    renderProviders();
  } catch (err) {
    toast(`${provider.name}: ${err.message}`, 'error');
    button.disabled = false;
    button.textContent = original;
  }
}
 
/** Sağlayıcı silme onay modalı */
function openDeleteProviderModal(slug) {
  const p = (state.providers || []).find((x) => x.slug === slug);
  const keys = p?.key_state?.total || 0;
  const name = p?.name || slug;
  confirmDialog({
    title: 'Sağlayıcı Sil',
    message: `"${esc(name)}" sağlayıcısını silmek istediğinizden emin misiniz?`,
    subject: `${keys} API anahtarı ${keys === 1 ? '' : 'lar'} (${name}) silinecek ve rotasyondan kaldırılacaktır. Geri alınabilir (silinen sağlayıcılar listesinden Geri Al ile).`,
    confirmText: 'Sağlayıcıyı Sil',
    icon: '🗑️',
  }).then((ok) => {
    if (!ok) return;
    api.delete(`/providers/${slug}`).then(({ data }) => {
      toast(`"${name}" silindi (${data?.keys ?? 0} anahtar)`, 'ok');
      api.get('/providers').then(({ data }) => {
        state.providers = data;
        renderProviders();
      });
    }).catch(() => toast('Silme başarısız', 'error'));
  });
}

/** Silinen sağlayıcıyı geri getirir; anahtarları yeniden etkinleştirir. */
function restoreProvider(slug) {
  const p = (state.providers || []).find((x) => x.slug === slug);
  if (!p) return;
  if (!p.is_deleted) return;
  api.send('POST', `/providers/${slug}/restore`).then(({ data }) => {
    state.providers = data;
    renderProviders();
  });
}

/* --------------------------- sağlayıcı ekleme --------------------------- */

/**
 * "Sağlayıcı Ekle" modalı: katalogdaki sağlayıcılar listelenir,
 * birine tıklanınca API anahtarı alanı açılır.
 */
function openAddProviderModal() {
  const list = [...(state.providers || [])].sort((a, b) => {
    const aa = hasActiveKey(a) ? 1 : 0;
    const bb = hasActiveKey(b) ? 1 : 0;
    return aa - bb || a.name.localeCompare(b.name, 'tr');
  });

  openModal(
    'Sağlayıcı Ekle',
    `<div class="field">
      <label>Sağlayıcı ara</label>
      <input class="input" id="spSearch" placeholder="openai, anthropic, groq, deepseek, elevenlabs…" autocomplete="off">
      <div class="field-hint">${fmtNum(list.length)} sağlayıcı · birine tıklayınca API anahtarı alanı açılır</div>
    </div>
    <div class="model-picker" id="spList" style="max-height:330px"></div>
    <div id="spKeyForm" style="display:none"></div>`,
    '<button class="btn" data-close>Kapat</button>'
  );

  const renderOptions = (q = '') => {
    const term = q.trim().toLowerCase();
    const filtered = (term
      ? list.filter((p) =>
          [p.name, p.slug, p.base_url].filter(Boolean).some((s) => s.toLowerCase().includes(term))
        )
      : list
    ).slice(0, 250);

    $('#spList').innerHTML =
      filtered
        .map((p) => {
          const active = hasActiveKey(p);
          return `<div class="sp-opt" data-slug="${esc(p.slug)}">
            <img src="${esc(p.logo_url || '')}" onerror="this.style.visibility='hidden'" style="width:19px;height:19px;border-radius:4px;flex-shrink:0">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:12.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
                ${active ? '<span class="pill pill-active" style="font-size:10px;padding:0 7px">aktif</span>' : ''}
                ${p.is_builtin ? '<span class="tag" style="font-size:10px">yerleşik</span>' : ''}
              </div>
              <div class="mono" style="font-size:10.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.slug)} · ${fmtNum(p.active_model_count)} ekli / ${fmtNum(p.available_model_count)} keşfedilen</div>
            </div>
            <span class="btn btn-sm" style="flex-shrink:0">${active ? 'Anahtar ekle' : 'Aktifleştir'}</span>
          </div>`;
        })
        .join('') || '<div class="empty" style="padding:26px">Eşleşen sağlayıcı yok</div>';
  };

  const showKeyForm = (slug) => {
    const p = (state.providers || []).find((x) => x.slug === slug);
    if (!p) return;

    const active = hasActiveKey(p);
    const meta = p.metadata || {};
    const isPlaceholder = meta.placeholder_url === true || /YOUR-|LOCATION-|PROJECT|REGION/.test(p.base_url || '');
    const envHint = Array.isArray(meta.env) && meta.env.length ? meta.env.join(' · ') : null;

    $('#spList').style.display = 'none';
    $('#spKeyForm').style.display = '';
    $('#spKeyForm').innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:13px;border-bottom:1px solid var(--border)">
        <img src="${esc(p.logo_url || '')}" onerror="this.style.visibility='hidden'" style="width:26px;height:26px;border-radius:5px">
        <div style="min-width:0">
          <div style="font-weight:600">${esc(p.name)}</div>
          <div class="mono muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.base_url)}</div>
        </div>
        <button class="btn btn-sm" id="spBack" style="margin-left:auto;flex-shrink:0">← Liste</button>
      </div>

      ${isPlaceholder ? `<div style="background:rgba(240,178,60,.1);border:1px solid rgba(240,178,60,.35);border-radius:7px;padding:9px 11px;margin-bottom:13px;font-size:12px;color:var(--yellow)">
        Bu sağlayıcının adresi yer tutucu. Kaydettikten sonra <strong>Düzenle</strong> ile gerçek adresi girmeniz gerekir.
      </div>` : ''}

      <div class="field">
        <label>API Anahtarı *</label>
        <input class="input mono" id="spKey" type="password" placeholder="sk-…" autocomplete="off">
        ${envHint ? `<div class="field-hint">Ortam değişkeni adı: <code class="inline">${esc(envHint)}</code></div>` : ''}
      </div>

      <div class="row">
        <div class="field"><label>Etiket</label><input class="input" id="spKeyName" placeholder="${active ? 'Yedek' : 'Ana'}"></div>
        <div class="field"><label>Öncelik</label><input class="input" id="spPrio" type="number" value="${p.key_state?.total || 0}" style="max-width:92px"></div>
      </div>
      <div class="field-hint" style="margin:-6px 0 13px">Öncelik küçük olan önce denenir; hata olursa sıradakine geçilir.</div>

      <button class="btn btn-primary btn-block" id="spSave">${active ? 'Anahtarı Ekle' : 'Kaydet ve Aktifleştir'}</button>`;

    const save = $('#spSave');
    save.addEventListener('click', async () => {
      const key = $('#spKey').value.trim();
      if (!key) {
        toast('API anahtarı gerekli', 'error');
        $('#spKey').focus();
        return;
      }

      save.disabled = true;
      save.textContent = 'Kaydediliyor…';
      try {
        const result = await api.send('POST', `/providers/${slug}/keys`, {
          key,
          key_name: $('#spKeyName').value.trim() || (active ? 'Yedek' : 'Ana'),
          priority: parseInt($('#spPrio').value || '0', 10),
        });

        // Sağlayıcı listesini tazele (key_state değişti)
        const { data } = await api.get('/providers');
        state.providers = data;

        const discovered = result.models_synced?.count || 0;
        toast(`${p.name} aktif edildi; ${discovered} model keşfedildi`, 'success');
        renderProviders();

        // Aynı modalda bir sonraki sağlayıcıyı seçmeye izin ver
        $('#spList').style.display = '';
        $('#spKeyForm').style.display = 'none';
        $('#spSearch').value = '';
        renderOptions();
      } catch (err) {
        toast(err.message, 'error');
        save.disabled = false;
        save.textContent = active ? 'Anahtarı Ekle' : 'Kaydet ve Aktifleştir';
      }
    });

    $('#spBack').addEventListener('click', () => {
      $('#spList').style.display = '';
      $('#spKeyForm').style.display = 'none';
    });

    $('#spKey').focus();
  };

  renderOptions();

  $('#spSearch').addEventListener('input', (e) => renderOptions(e.target.value));
  $('#spList').addEventListener('click', (e) => {
    const opt = e.target.closest('.sp-opt');
    if (opt) showKeyForm(opt.dataset.slug);
  });
}

async function providerKeys(slug) {
  const { data } = await api.get(`/providers/${slug}/keys`);
  const p = state.providers.find((x) => x.slug === slug);

  const rows = data
    .map(
      (k) => `<tr><td>${esc(k.key_name || '—')}</td><td class="mono">${esc(k.key_mask)}</td>
      <td class="num">${k.priority}</td><td><span class="pill pill-${esc(k.status)}">${esc(k.status)}</span></td>
      <td class="num">${fmtNum(k.usage_count)}</td>
      <td class="num"><button class="btn btn-sm btn-danger" data-del="${k.id}">Sil</button></td></tr>`
    )
    .join('');

  openModal(
    `${p.name} — API Anahtarları`,
    `<div class="field"><label>Yeni Anahtar Ekle</label>
      <div class="row">
        <input class="input" id="newKeyName" placeholder="Etiket (örn. Ana, Yedek)">
        <input class="input" id="newKeyVal" placeholder="sk-..." type="password">
        <input class="input" id="newKeyPrio" type="number" value="0" style="max-width:80px" title="Öncelik">
        <button class="btn btn-primary" id="addKeyBtn">Ekle</button>
      </div>
      <div class="field-hint">Öncelik küçükten büyüğe: ilk anahtar denenir. Hata olursa sıradakine geçilir.</div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Etiket</th><th>Anahtar</th><th class="num">Öncelik</th><th>Durum</th><th class="num">Kullanım</th><th></th></tr></thead>
    <tbody id="keyRows">${rows || '<tr><td colspan="6" class="empty" style="padding:20px">Anahtar yok</td></tr>'}</tbody></table></div>`,
    '<button class="btn" data-close>Kapat</button>',
    {
      replace: true,
      // Onay diyaloğu kapanınca alt katman yeniden çizilir; bu yüzden
      // dinleyicileri her çizimde yeniden bağlıyoruz.
      onRender: () => {
        $('#addKeyBtn')?.addEventListener('click', async () => {
          const key = $('#newKeyVal').value.trim();
          if (!key) return toast('Anahtar giriniz', 'error');
          try {
            const result = await api.send('POST', `/providers/${slug}/keys`, {
              key,
              key_name: $('#newKeyName').value.trim() || 'Anahtar',
              priority: parseInt($('#newKeyPrio').value || '0', 10),
            });
            toast(`Anahtar eklendi; ${result.models_synced?.count || 0} model keşfedildi`, 'success');
            providerKeys(slug);
            PAGES.providers.render();
          } catch (err) { toast(err.message, 'error'); }
        });

        $('#keyRows')?.addEventListener('click', async (e) => {
          const btn = e.target.closest('button[data-del]');
          if (!btn) return;
          const row = data.find((k) => k.id === btn.dataset.del);

          const ok = await confirmDialog({
            title: 'API anahtarı silinsin mi?',
            message: 'Bu anahtar sağlayıcıya yapılan isteklerde kullanılamaz ve kaldırılamaz.',
            subject: `${row?.key_name || 'Anahtar'} · ${row?.key_mask || ''}`,
            confirmText: 'Anahtarı Sil',
          });
          if (!ok) return;

          await api.send('DELETE', `/keys/${btn.dataset.del}`);
          toast('Anahtar silindi', 'success');
          providerKeys(slug);
          PAGES.providers.render();
        });
      },
    }
  );
}

async function removeModel(modelId) {
  const model = state.models.find((m) => m.id === modelId);
  if (!model) return;

  const ok = await confirmDialog({
    title: 'Model kaldırılsın mı?',
    message: 'Model panelden ve API model listesinden kaldırılır. Katalogdaki kaydı silinmez; daha sonra yeniden ekleyebilirsiniz.',
    subject: `${model.provider_slug} · ${model.original_name}`,
    confirmText: 'Modeli Kaldır',
  });
  if (!ok) return;

  try {
    await api.send('PATCH', `/models/${modelId}`, { is_active: false });
    toast('Model kaldırıldı', 'success');
    PAGES.models.render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openAddModelModal() {
  let available = [];
  try {
    const result = await api.get('/models/available?limit=4000');
    available = result.data || [];
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const providers = [...new Map(available.map((m) => [m.provider_slug, m.provider_name || m.provider_slug])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'tr'));

  openModal(
    'Model Ekle',
    `<div class="toolbar" style="margin-bottom:12px">
       <input class="input grow" id="availableModelSearch" placeholder="Model veya sağlayıcı ara…">
       <select class="select" id="availableProviderFilter">
         <option value="">Tüm sağlayıcılar</option>
         ${providers.map(([slug, name]) => `<option value="${esc(slug)}">${esc(name)}</option>`).join('')}
       </select>
     </div>
     <div class="field-hint" style="margin-bottom:10px">Yalnızca aktif API anahtarı bulunan sağlayıcıların modelleri listelenir.</div>
     <div class="table-wrap" style="max-height:56vh"><table>
       <thead><tr><th>Model</th><th>Sağlayıcı</th><th>Kategoriler</th><th class="num"></th></tr></thead>
       <tbody id="availableModelBody"></tbody>
     </table></div>
     <div class="empty" id="availableModelEmpty" style="display:none;padding:24px">Uygun model bulunamadı</div>`,
    '<button class="btn" data-close>Kapat</button>',
    { replace: false }
  );

  const renderAvailable = () => {
    const q = ($('#availableModelSearch').value || '').toLowerCase();
    const provider = $('#availableProviderFilter').value;
    const filtered = available.filter((m) => {
      const haystack = [m.original_name, m.alias, m.display_name, m.provider_slug, m.provider_name]
        .filter(Boolean).join(' ').toLowerCase();
      return (!q || haystack.includes(q)) && (!provider || m.provider_slug === provider);
    });

    $('#availableModelBody').innerHTML = filtered.map((m) => `<tr>
      <td><div style="font-weight:550">${esc(m.display_name || m.original_name)}</div>
        <div class="mono muted" style="font-size:11px">${esc(m.original_name)}</div></td>
      <td class="muted small">${esc(m.provider_slug)}</td>
      <td>${tags(m.categories)}</td>
      <td class="num"><button class="btn btn-sm ${m.is_active ? '' : 'btn-primary'}" data-add-model="${esc(m.id)}" ${m.is_active ? 'disabled' : ''}>${m.is_active ? 'Ekli' : 'Ekle'}</button></td>
    </tr>`).join('');
    $('#availableModelEmpty').style.display = filtered.length ? 'none' : 'block';
  };

  $('#availableModelSearch').addEventListener('input', renderAvailable);
  $('#availableProviderFilter').addEventListener('change', renderAvailable);
  $('#availableModelBody').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-add-model]');
    if (!button) return;
    button.disabled = true;
    try {
      await api.send('PATCH', `/models/${button.dataset.addModel}`, { is_active: true });
      const model = available.find((m) => m.id === button.dataset.addModel);
      if (model) model.is_active = 1;
      toast('Model eklendi', 'success');
      renderAvailable();
      PAGES.models.render();
    } catch (err) {
      button.disabled = false;
      toast(err.message, 'error');
    }
  });

  renderAvailable();
}

function editProvider(slug) {
  const p = state.providers.find((x) => x.slug === slug);
  if (!p) return;

  openModal(
    `Düzenle: ${p.name}`,
    `<div class="field"><label>Ad</label><input class="input" id="fName" value="${esc(p.name)}"></div>
     <div class="field"><label>Base URL</label><input class="input mono" id="fUrl" value="${esc(p.base_url)}">
       <div class="field-hint">Yerel modeller için örn. <code class="inline">http://127.0.0.1:11434/v1</code></div></div>
     <div class="field"><label>API Formatı</label>
       <select class="select" id="fFormat">
         <option value="openai"${p.api_format === 'openai' ? ' selected' : ''}>OpenAI uyumlu</option>
         <option value="anthropic"${p.api_format === 'anthropic' ? ' selected' : ''}>Anthropic</option>
         <option value="google"${p.api_format === 'google' ? ' selected' : ''}>Google</option>
       </select></div>
     <div class="field"><label>Durum</label>
       <select class="select" id="fActive">
         <option value="1"${p.is_active ? ' selected' : ''}>Aktif</option>
         <option value="0"${!p.is_active ? ' selected' : ''}>Pasif</option>
       </select></div>`,
    `<button class="btn" data-close>Vazgeç</button><button class="btn btn-primary" id="saveProv">Kaydet</button>`
  );

  $('#saveProv').addEventListener('click', async () => {
    try {
      await api.send('PATCH', `/providers/${slug}`, {
        name: $('#fName').value.trim(),
        base_url: $('#fUrl').value.trim(),
        api_format: $('#fFormat').value,
        is_active: $('#fActive').value === '1',
      });
      toast('Kaydedildi', 'success');
      closeModal();
      PAGES.providers.render();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function editModel(modelId) {
  const m = state.models.find((x) => x.id === modelId);
  if (!m) return;

  openModal(
    'Modeli Düzenle',
    `<div class="field"><label>Model</label>
       <div class="mono muted">${esc(m.provider_slug)} / ${esc(m.original_name)}</div></div>
     <div class="field"><label>Takma Ad (alias)</label>
       <input class="input" id="fAlias" value="${esc(m.alias || '')}" placeholder="örn. gpt-4, hizli-model">
       <div class="field-hint">API'de <code class="inline">model</code> olarak bu ad kullanılacak. Boş bırakırsanız orijinal ad geçerli olur.</div></div>
     <div class="row">
       <div class="field"><label>Giriş maliyeti ($ / 1M token)</label>
         <input class="input" id="fInputPrice" type="number" min="0" step="0.000001" value="${m.pricing?.input ?? ''}" placeholder="örn. 2.5"></div>
       <div class="field"><label>Çıkış maliyeti ($ / 1M token)</label>
         <input class="input" id="fOutputPrice" type="number" min="0" step="0.000001" value="${m.pricing?.output ?? ''}" placeholder="örn. 10"></div>
     </div>
     <div class="field-hint">Bu değerler sağlayıcının döndürdüğü gerçek token kullanımıyla log maliyetini hesaplamak için kullanılır.</div>
     <div class="field"><label>Model Durumu</label>
       <select class="select" id="fModelActive">
         <option value="1"${m.is_active ? ' selected' : ''}>Aktif (API'de listelenir)</option>
         <option value="0"${!m.is_active ? ' selected' : ''}>Devre dışı</option>
       </select></div>`,
    `<button class="btn" data-close>Vazgeç</button><button class="btn btn-primary" id="saveAlias">Kaydet</button>`
  );

  $('#saveAlias').addEventListener('click', async () => {
    try {
      await api.send('PATCH', `/models/${modelId}`, {
        alias: $('#fAlias').value.trim(),
        pricing: {
          input: $('#fInputPrice').value,
          output: $('#fOutputPrice').value,
        },
        is_active: $('#fModelActive').value === '1',
      });
      toast('Kaydedildi', 'success');
      closeModal();
      PAGES.models.render();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function editApiKey(tr) {
  const existing = tr ? state.apiKeys?.find((a) => a.id === tr.querySelector('[data-id]').dataset.id) : null;
  if (tr && !existing) await loadApiKeys();
  const a = existing || null;

  const cats = state.categories || [];
  const selected = a && a.model_scope !== '*' ? JSON.parse(a.model_scope) : [];

  openModal(
    a ? `Düzenle: ${a.name}` : 'Yeni API Anahtarı',
    `<div class="field"><label>Ad *</label><input class="input" id="aName" value="${esc(a?.name || '')}" placeholder="örn. OpenCode, Claude Code"></div>
     <div class="field"><label>Açıklama</label><input class="input" id="aDesc" value="${esc(a?.description || '')}"></div>

     <div class="field"><label>Model Kapsamı</label>
       <select class="select" id="aScopeMode">
         <option value="all"${!a || selected.length === 0 ? ' selected' : ''}>Tüm modeller</option>
         <option value="custom"${selected.length ? ' selected' : ''}>Seçili modeller</option>
       </select>
       <div id="scopeBox" style="margin-top:9px;${selected.length ? '' : 'display:none'}">
         <input class="input" id="aScopeSearch" placeholder="Model ara…" style="margin-bottom:7px">
         <div class="model-picker" id="scopeList"></div>
         <div class="field-hint">Boş bırakırsanız tüm modeller erişilebilir.</div>
       </div>
     </div>

     <div class="row">
       <div class="field"><label>Dakikada istek</label><input class="input" id="aRate" type="number" min="0" value="${a?.rate_limit ?? ''}" placeholder="sınırsız"></div>
       <div class="field"><label>Günlük token</label><input class="input" id="aToken" type="number" min="0" value="${a?.daily_token_limit ?? ''}" placeholder="sınırsız"></div>
     </div>
     <div class="field"><label>Günlük istek sayısı</label><input class="input" id="aReq" type="number" min="0" value="${a?.daily_request_limit ?? ''}" placeholder="sınırsız"></div>
     <div class="row">
       <div class="field"><label>Başlangıç tarihi</label><input class="input" id="aFrom" type="date" value="${esc(a?.valid_from?.slice(0, 10) || '')}"></div>
       <div class="field"><label>Bitiş tarihi</label><input class="input" id="aUntil" type="date" value="${esc(a?.valid_until?.slice(0, 10) || '')}"></div>
     </div>`,
    `<button class="btn" data-close>Vazgeç</button><button class="btn btn-primary" id="saveApiKey">${a ? 'Kaydet' : 'Oluştur'}</button>`
  );

  let chosen = new Set(selected);

  const loadPicker = async (q = '') => {
    const { data } = await api.get(`/models?limit=4000${q ? `&search=${encodeURIComponent(q)}` : ''}`);
    $('#scopeList').innerHTML = data
      .map(
        (m) => `<label class="model-picker-item">
        <input type="checkbox" value="${esc(m.alias || m.original_name)}" ${chosen.has(m.alias || m.original_name) ? 'checked' : ''}>
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.display_name || m.original_name)}</div>
          <div class="muted" style="font-size:11px">${esc(m.provider_slug)} · ${tags(m.categories)}</div>
        </div></label>`
      )
      .join('') || '<div class="empty" style="padding:18px">Model bulunamadı</div>';
  };

  await loadPicker();

  $('#scopeList').addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    if (e.target.checked) chosen.add(e.target.value);
    else chosen.delete(e.target.value);
  });
  $('#aScopeSearch').addEventListener('input', (e) => loadPicker(e.target.value));
  $('#aScopeMode').addEventListener('change', (e) => {
    $('#scopeBox').style.display = e.target.value === 'custom' ? '' : 'none';
  });

  $('#saveApiKey').addEventListener('click', async () => {
    const name = $('#aName').value.trim();
    if (!name) return toast('Ad zorunlu', 'error');

    const payload = {
      name,
      description: $('#aDesc').value.trim(),
      rate_limit: parseInt($('#aRate').value || '0', 10) || null,
      daily_token_limit: parseInt($('#aToken').value || '0', 10) || null,
      daily_request_limit: parseInt($('#aReq').value || '0', 10) || null,
      valid_from: $('#aFrom').value || null,
      valid_until: $('#aUntil').value || null,
    };
    if ($('#aScopeMode').value === 'custom' && chosen.size) payload.models = [...chosen];

    try {
      if (a) {
        await api.send('PATCH', `/api-keys/${a.id}`, payload);
        toast('Güncellendi', 'success');
        closeModal();
      } else {
        const res = await api.send('POST', '/api-keys', payload);
        closeModal();
        showNewKey(res.data.key, payload.models?.length || 0);
      }
      PAGES.apikeys.render();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function loadApiKeys() {
  const { data } = await api.get('/api-keys');
  state.apiKeys = data;
  return data;
}

function showNewKey(key, modelCount) {
  openModal(
    'API Anahtarı Oluşturuldu',
    `<div class="field"><label>Anahtarınız</label>
       <div class="mono" style="background:var(--bg-alt);border:1px solid var(--border);border-radius:8px;padding:12px;word-break:break-all;color:var(--green)">${esc(key)}</div>
       <div class="field-hint">Bu anahtar yalnızca şimdi gösterilir. Hemen kaydedin.</div></div>
     <div class="field"><label>Kullanım</label>
       <div class="mono small" style="background:var(--bg-alt);border:1px solid var(--border);border-radius:8px;padding:11px">
curl ${location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"merhaba"}]}'
       </div></div>
     ${modelCount ? `<div class="field-hint">${modelCount} modele erişim verildi.</div>` : ''}`,
    '<button class="btn btn-primary" data-close>Tamam</button>'
  );
}

/* --------------------------------- başlatma --------------------------------- */

const TITLES = {
  dashboard: 'Genel Bakış',
  providers: 'Sağlayıcılar',
  keys: 'Sağlayıcı Anahtarları',
  models: 'Modeller',
  apikeys: 'API Anahtarları',
  logs: 'İstek Logları',
};

let currentPage = 'dashboard';

async function navigate(page, updateUrl = true) {
  currentPage = page;
  if (updateUrl) {
    const url = new URL(location.href);
    if (page === 'dashboard') url.searchParams.delete('page');
    else url.searchParams.set('page', page);
    history.replaceState(null, '', url);
  }
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('#pageTitle').textContent = TITLES[page] || page;
  content.innerHTML = '<div style="display:flex;justify-content:center;padding:60px"><div class="spinner"></div></div>';
  try {
    await PAGES[page].render();
  } catch (err) {
    content.innerHTML = `<div class="card"><div class="empty"><div class="empty-icon">⚠️</div>Yüklenemedi: ${esc(err.message)}</div></div>`;
  }
}

// nav-item tıklamalarını PAGES.render() ile birleştir
Object.values(PAGES).forEach((p) => {
  if (!p.render) p.render = p;
});

$$('.nav-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.page)));
$('#modalClose').addEventListener('click', closeModal);
$('#modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop' || e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());

async function health() {
  try {
    const r = await fetch('/health');
    const d = await r.json();
    const b = $('#serverBadge');
    b.textContent = `● ${d.counts.models} model · ${d.counts.providers} sağlayıcı`;
    b.className = 'badge ok';
  } catch {
    const b = $('#serverBadge');
    b.textContent = '● bağlantı yok';
    b.className = 'badge err';
  }
}

// Açılış sayfası: ?page=providers gibi bağlantılar desteklenir
function initialPage() {
  const p = new URL(location.href).searchParams.get('page');
  return p && TITLES[p] ? p : 'dashboard';
}

$('#logoutBtn').addEventListener('click', async () => {
  await authFetch('/logout', {});
  window.location.reload();
});

initAuth();
setInterval(() => { if (authUser) health(); }, 15000);

// Tarayıcı geri/ileri tuşları
window.addEventListener('popstate', () => navigate(initialPage(), false));
