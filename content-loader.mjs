const MESSAGES = {
  network: '请检查网络后重新加载。',
  timeout: '内容加载超时，请检查网络后重试。',
  format: '短句清单格式不正确，请家属检查。',
  empty: '短句清单没有内容，请家属添加短句。',
  fields: '短句缺少有效编号、文字或音频路径，请家属检查。',
  duplicate: '短句编号重复，请家属检查。',
  path: '音频路径需要指向本站的相对文件路径，请家属检查。',
};

export class ContentError extends Error {
  constructor(code) { super(code); this.code = code; this.publicMessage = MESSAGES[code] || MESSAGES.network; }
}

export function validatePhrases(data) {
  if (!Array.isArray(data)) throw new ContentError('format');
  if (!data.length) throw new ContentError('empty');
  const ids = new Set();
  const base = 'https://practice.invalid/project/';
  return data.map(item => {
    if (!item || ['id', 'text', 'audio'].some(key => typeof item[key] !== 'string' || !item[key].trim())
      || item.id !== item.id.trim() || item.audio !== item.audio.trim()) throw new ContentError('fields');
    if (ids.has(item.id)) throw new ContentError('duplicate');
    ids.add(item.id);
    let url;
    try { url = new URL(item.audio, base); } catch { throw new ContentError('path'); }
    if (/^[\/\\]|:|\\/.test(item.audio) || url.origin !== new URL(base).origin
      || !url.pathname.startsWith('/project/') || url.pathname.endsWith('/') || url.hash) throw new ContentError('path');
    return { id: item.id, text: item.text, audio: item.audio };
  });
}

export async function loadPhrases({ fetcher = globalThis.fetch, clock = globalThis, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    const request = Promise.resolve().then(() => fetcher('content/phrases.json', { signal: controller.signal, cache: 'no-cache' }))
      .then(async response => {
        if (!response.ok) throw new ContentError('network');
        let data;
        try { data = await response.json(); } catch { throw new ContentError('format'); }
        return validatePhrases(data);
      });
    const deadline = new Promise((_, reject) => {
      timer = clock.setTimeout(() => { reject(new ContentError('timeout')); controller.abort(); }, timeoutMs);
    });
    return await Promise.race([request, deadline]);
  } finally { clock.clearTimeout(timer); }
}
