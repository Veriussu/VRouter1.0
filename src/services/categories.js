const { encrypt, hashKey, maskKey } = require('../crypto');

/**
 * models.dev verisinden gelen ham model verisini VRouter'ın
 * kategori + yetenek formatına dönüştürür.
 */

const TYPE_MARKERS = [
  { re: /embed/i,              category: 'embedding' },
  { re: /whisper|transcri|speech-to-text|stt/i, category: 'transcription' },
  { re: /tts|text-to-speech|voice/i, category: 'tts' },
  { re: /dall-?e|imagen|flux|sdxl|stable-diffusion|midjourney|image-gen/i, category: 'image' },
  { re: /sora|veo|runway|video/i, category: 'video' },
  { re: /rerank|rank/i,        category: 'rerank' },
  { re: /moderation|guard/i,   category: 'moderation' },
  { re: /code|coder|starcoder/i, category: 'code' },
];

function inferCategory(modelId, name, modalities = {}, flags = {}) {
  const categories = new Set();
  const inp = modalities.input || [];
  const out = modalities.output || [];

  const textOut = out.includes('text');
  const textIn = inp.includes('text');

  // Görüntü üretimi
  if (out.includes('image')) categories.add('image');
  // Görüntü/veri anlama (metin üreten modeller)
  if (textOut && (inp.includes('image') || inp.includes('pdf'))) categories.add('vision');
  // Ses üretimi
  if (out.includes('audio')) categories.add(textIn ? 'tts' : 'audio');
  // Ses girdisi
  if (inp.includes('audio') && !out.includes('audio')) categories.add('transcription');
  // Video
  if (out.includes('video')) categories.add('video');
  if (inp.includes('video')) categories.add('video-understanding');

  // Metin üreten temel yetenekler
  if (textOut && textIn) {
    categories.add('chat');
    if (inp.includes('image')) categories.add('vision');
    if (flags.reasoning) categories.add('reasoning');
    if (flags.tool_call && flags.reasoning) categories.add('planning');
    if (flags.structured_output) categories.add('structured-output');
  }

  // İsim bazlı özel tipler (gömme, TTS, görsel üretim vb.)
  const haystack = `${modelId} ${name || ''}`;
  for (const { re, category } of TYPE_MARKERS) {
    if (re.test(haystack)) categories.add(category);
  }

  if (categories.has('code')) categories.add('chat');
  // Gömme modelleri "chat" olmamalı
  if (categories.has('embedding')) {
    categories.delete('chat');
    categories.delete('vision');
  }

  return categories.size ? [...categories] : ['chat'];
}

function inferCapabilities(flags = {}, modalities = {}) {
  const caps = [];
  if (flags.tool_call) caps.push('function_calling');
  if (flags.structured_output) caps.push('structured_output');
  if (flags.temperature) caps.push('temperature');
  if (flags.reasoning) caps.push('reasoning');
  if (flags.attachment) caps.push('attachment');
  if (flags.open_weights) caps.push('open_weights');
  if ((modalities.output || []).includes('text')) caps.push('text_output');
  if ((modalities.input || []).includes('image')) caps.push('image_input');
  if ((modalities.input || []).includes('audio')) caps.push('audio_input');
  if ((modalities.output || []).includes('audio')) caps.push('audio_output');
  if ((modalities.output || []).includes('image')) caps.push('image_output');
  if ((modalities.input || []).includes('video')) caps.push('video_input');
  if ((modalities.output || []).includes('video')) caps.push('video_output');
  if ((modalities.input || []).includes('pdf')) caps.push('pdf_input');
  return caps;
}

function normalizeCost(cost = {}) {
  const c = {};
  if (typeof cost.input === 'number') c.input = cost.input;
  if (typeof cost.output === 'number') c.output = cost.output;
  if (typeof cost.cache_read === 'number') c.cache_read = cost.cache_read;
  if (typeof cost.cache_write === 'number') c.cache_write = cost.cache_write;
  if (typeof cost.reasoning === 'number') c.reasoning = cost.reasoning;
  if (typeof cost.input_audio === 'number') c.input_audio = cost.input_audio;
  if (typeof cost.output_audio === 'number') c.output_audio = cost.output_audio;
  if (cost.tiers) c.tiers = cost.tiers;
  if (cost.context_over_200k) c.context_over_200k = cost.context_over_200k;
  return c;
}

module.exports = { inferCategory, inferCapabilities, normalizeCost };
