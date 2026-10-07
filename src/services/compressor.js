const config = require('../config');

/**
 * Token tasarrufu için hafif prompt sıkıştırma.
 *
 * Yöntemler (güvenli olanlar uygulanır):
 *  - Tekrarlayan boş satırların daraltılması
 *  - Aynı mesajın birebir tekrarlarının kaldırılması
 *  - Uzun araç çıktılarında ortadaki elemanların atılması
 *  - Çok eski konuşma adımlarının özetlenmesi (yalnızca aşınca)
 *
 * Not: Anlamlı içeriği özetleyen bir model çağrısı bilinçli olarak YAPILMAZ;
 * bu, kullanıcının çıktısını sessizce değiştirir. Sıkıştırma opt-in'tir.
 */

const repeatWhiteSpace = (s) => s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

function messagesFingerprint(messages) {
  return messages
    .map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('|');
}

function estimateTokens(text) {
  if (!text) return 0;
  // yaklaşık: 4 karakter ≈ 1 token (Türkçe/ASCII karışımı için iyi bir tahmin)
  return Math.ceil(String(text).length / 4);
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'image_url') return '';
        if (part?.type === 'input_audio') return '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return String(content ?? '');
}

/**
 * @param {object} body OpenAI uyumlu istek gövdesi
 * @returns {{body:object, savedTokens:number, applied:boolean, notes:string[]}}
 */
function compress(body) {
  const notes = [];
  if (!config.COMPRESSION_ENABLED) return { body, savedTokens: 0, applied: false, notes: ['sıkıştırma kapalı'] };

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return { body, savedTokens: 0, applied: false, notes: ['mesaj yok'] };

  const before = estimateTokens(messages.map((m) => contentToText(m.content)).join('\n'));
  if (before < config.COMPRESSION_THRESHOLD) {
    return { body, savedTokens: 0, applied: false, notes: ['eşik altında'] };
  }

  const out = [];
  let seen = new Set();
  let removed = 0;
  let shortened = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const fp = messagesFingerprint([msg]);

    // 1) Birebir tekrar (ardışık veya tüm konuşma)
    if (seen.has(fp)) { removed++; continue; }
    seen.add(fp);

    // 2) Uzun tool/araç çıktılarını ortadan kırp
    const text = contentToText(msg.content);
    if (text.length > 6000 && (msg.role === 'tool' || msg.role === 'function')) {
      const head = text.slice(0, 2000);
      const tail = text.slice(-1500);
      out.push({ ...msg, content: `${head}\n\n...[${text.length - 3500} karakter kısaltıldı]...\n\n${tail}` });
      shortened++;
      continue;
    }

    // 3) Boşluk sadeleştirme (ilk ve son kullanıcı mesajlarında dokunma)
    const isEdge = i === 0 || i === messages.length - 1;
    if (!isEdge && typeof msg.content === 'string') {
      const trimmed = repeatWhiteSpace(msg.content);
      if (trimmed !== msg.content) { out.push({ ...msg, content: trimmed }); shortened++; continue; }
    }

    out.push(msg);
  }

  // 4) Çok eski adımları kaldır (system + son 12 mesaj korunur)
  const KEEP_RECENT = 12;
  let final = out;
  if (out.length > KEEP_RECENT + 2) {
    const head = out.filter((m) => m.role === 'system');
    const rest = out.filter((m) => m.role !== 'system');
    const tail = rest.slice(-KEEP_RECENT);
    const dropped = rest.slice(0, rest.length - KEEP_RECENT);
    const summary = {
      role: 'system',
      content: `[VRouter] Konuşmanın ${dropped.length} eski mesajı özetlendi: ${dropped
        .map((m) => m.role)
        .join(', ')}.`,
    };
    final = [...head, summary, ...tail];
    removed += dropped.length;
  }

  const after = estimateTokens(final.map((m) => contentToText(m.content)).join('\n'));
  const savedTokens = Math.max(0, before - after);

  if (removed) notes.push(`${removed} tekrar/eski mesaj kaldırıldı`);
  if (shortened) notes.push(`${shortened} mesaj sadeleştirildi`);

  return {
    body: { ...body, messages: final },
    savedTokens,
    applied: savedTokens > 0,
    notes,
  };
}

module.exports = { compress, estimateTokens };
