// Word list loading and lookups. The built-in list ships with the app; a custom
// list imported by the user is stored in the Cache API so it survives reloads.

const BUILTIN_URL = 'data/enable.txt';
const CUSTOM_CACHE = 'grabble-custom-dict';
const CUSTOM_KEY = 'custom-dictionary';

export const LETTER_POINTS = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
  N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

let words = new Set();
let byLength = new Map();
let info = { name: 'ENABLE', custom: false, count: 0 };

export function parseWordList(text) {
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    // Take the first token so lists with definitions after the word still work.
    const w = line.trim().split(/[\s,;\t]/)[0];
    if (w && /^[A-Za-z]+$/.test(w)) out.add(w.toUpperCase());
  }
  return out;
}

function use(set, meta) {
  words = set;
  byLength = new Map();
  info = { ...meta, count: set.size };
}

export async function loadDictionary() {
  try {
    const cache = await caches.open(CUSTOM_CACHE);
    const res = await cache.match(CUSTOM_KEY);
    if (res) {
      const name = res.headers.get('x-name') || 'Custom list';
      const set = parseWordList(await res.text());
      if (set.size) {
        use(set, { name, custom: true });
        return info;
      }
    }
  } catch { /* Cache API unavailable; fall back to built-in */ }

  const res = await fetch(BUILTIN_URL);
  if (!res.ok) throw new Error('Could not load the dictionary');
  use(parseWordList(await res.text()), { name: 'ENABLE', custom: false });
  return info;
}

export async function importDictionary(file) {
  const text = await file.text();
  const set = parseWordList(text);
  if (set.size < 100) throw new Error('That file does not look like a word list');
  const name = file.name.replace(/\.[^.]+$/, '') || 'Custom list';
  try {
    const cache = await caches.open(CUSTOM_CACHE);
    await cache.put(CUSTOM_KEY, new Response([...set].join('\n'), {
      headers: { 'content-type': 'text/plain', 'x-name': name },
    }));
  } catch { /* still usable for this session */ }
  use(set, { name, custom: true });
  return info;
}

export async function resetDictionary() {
  try { await caches.delete(CUSTOM_CACHE); } catch { /* ignore */ }
  return loadDictionary();
}

export function dictionaryInfo() {
  return info;
}

export function isWord(word) {
  return words.has(word.toUpperCase());
}

export function score(word) {
  let total = 0;
  for (const ch of word.toUpperCase()) total += LETTER_POINTS[ch] || 0;
  return total;
}

const sortLetters = (w) => w.split('').sort().join('');

function wordsOfLength(n) {
  if (!byLength.size) {
    for (const w of words) {
      let list = byLength.get(w.length);
      if (!list) byLength.set(w.length, (list = []));
      list.push(w);
    }
  }
  return byLength.get(n) || [];
}

// Valid words that use exactly the same letters, excluding the word itself.
export function anagrams(word, limit = 12) {
  const w = word.toUpperCase();
  const key = sortLetters(w);
  const out = [];
  for (const cand of wordsOfLength(w.length)) {
    if (cand !== w && sortLetters(cand) === key) {
      out.push(cand);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Letters the scanner tends to mix up with each other.
const LOOKALIKES = {
  B: 'RE', C: 'GO', D: 'OB', E: 'FB', F: 'EP', G: 'CO', H: 'N', I: 'LT', K: 'X',
  L: 'I', M: 'N', N: 'MH', O: 'DQC', P: 'RF', Q: 'O', R: 'BP', T: 'I', U: 'V',
  V: 'UY', W: 'V', X: 'K', Y: 'V', Z: '',
};

// Valid words one misread letter away from `word`, for scanned results that
// aren't valid as read.
export function lookalikeWords(word, limit = 4) {
  const w = word.toUpperCase();
  const out = [];
  for (let i = 0; i < w.length; i++) {
    for (const alt of LOOKALIKES[w[i]] || '') {
      const cand = w.slice(0, i) + alt + w.slice(i + 1);
      if (words.has(cand) && !out.includes(cand)) out.push(cand);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
