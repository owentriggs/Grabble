// Online definitions. Free Dictionary API first (clean data, common words),
// then Wiktionary, which covers far more of the odd words Scrabble allows.

const CACHE_KEY = 'grabble-defs';
const CACHE_MAX = 200;
const TIMEOUT_MS = 7000;

const memory = new Map(Object.entries(readCache()));

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
}

function remember(word, result) {
  memory.set(word, result);
  while (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(memory))); } catch { /* full */ }
}

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const stripHTML = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();

function fromFreeDictionary(data) {
  if (!Array.isArray(data)) return [];
  const byPos = new Map();
  for (const entry of data) {
    for (const m of entry.meanings || []) {
      const defs = byPos.get(m.partOfSpeech) || [];
      for (const d of m.definitions || []) if (d.definition) defs.push(d.definition);
      byPos.set(m.partOfSpeech, defs);
    }
  }
  return [...byPos].map(([pos, defs]) => ({ pos, defs }));
}

function fromWiktionary(data) {
  const english = (data && data.en) || [];
  return english
    .map((e) => ({
      pos: (e.partOfSpeech || '').toLowerCase(),
      defs: (e.definitions || []).map((d) => stripHTML(d.definition || '')).filter(Boolean),
    }))
    .filter((e) => e.defs.length);
}

// Resolves to { entries: [{ pos, defs }], source } or { entries: [] } when no
// definition exists. Rejects when offline or both services fail.
export async function lookup(word) {
  const w = word.toLowerCase();
  if (memory.has(w)) return memory.get(w);
  if (!navigator.onLine) throw new Error('offline');

  let entries = [];
  let source = '';
  let failures = 0;
  try {
    entries = fromFreeDictionary(await getJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`));
    source = 'Free Dictionary API';
  } catch { failures++; }
  if (!entries.length) {
    try {
      entries = fromWiktionary(await getJSON(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}`));
      source = 'Wiktionary';
    } catch { failures++; }
  }
  if (failures === 2) throw new Error('lookup failed');

  const result = entries.length
    ? { entries: entries.slice(0, 3).map((e) => ({ pos: e.pos, defs: e.defs.slice(0, 2) })), source }
    : { entries: [] };
  remember(w, result);
  return result;
}
