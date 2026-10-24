import {
  loadDictionary, importDictionary, resetDictionary, dictionaryInfo,
  isWord, score, anagrams, lookalikeWords, LETTER_POINTS,
} from './dictionary.js';
import { readTiles, getWorker, onOcrStatus } from './ocr.js';
import {
  hasCamera, startCamera, stopCamera, isRunning, flipCamera,
  torchSupported, setTorch, captureGuide, fileToCanvas,
} from './camera.js';

const APP_VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

const state = {
  screen: 'scan',
  minLen: store.get('grabble-min-len', 3),
  history: store.get('grabble-history', []),
  dictReady: null,
  cameraWanted: false,
  torch: false,
  busy: false,
};

// ---------- Helpers ----------

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function haptic(pattern) {
  if (navigator.vibrate) try { navigator.vibrate(pattern); } catch { /* ignore */ }
}

const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
};

function tilesHTML(letters) {
  return `<div class="tiles" style="--n:${Math.max(letters.length, 1)}">${letters.map((ch) => ch === '?'
    ? '<div class="tile unknown">?</div>'
    : `<div class="tile">${ch}<sub>${LETTER_POINTS[ch] ?? ''}</sub></div>`).join('')}</div>`;
}

function evaluate(letters) {
  const word = letters.join('');
  if (!word) return null;
  if (word.includes('?')) {
    return { kind: 'warn', icon: 'warn', title: 'Check the tiles', text: 'Some tiles could not be read. Tap the tiles to fix them.' };
  }
  if (word.length < state.minLen) {
    return { kind: 'warn', icon: 'warn', title: 'Too short', text: `Words need at least ${state.minLen} letters.`, word };
  }
  if (isWord(word)) {
    return { kind: 'valid', icon: 'check', title: 'Valid word', text: `${word} · ${score(word)} points`, word, valid: true };
  }
  return { kind: 'invalid', icon: 'cross', title: 'Not a word', text: `${word} isn't in ${dictionaryInfo().name}`, word, valid: false, anagrams: anagrams(word) };
}

function renderVerdict(v) {
  if (!v) return '';
  let html = `<div class="verdict ${v.kind} pop">
      <div class="badge">${ICONS[v.icon]}</div>
      <div><h2>${v.title}</h2><p>${v.text}</p></div>
    </div>`;
  if (v.anagrams && v.anagrams.length) {
    html += `<div class="anagrams"><h4>Same letters, valid words</h4>
      <div class="chips">${v.anagrams.map((a) => `<span class="chip">${a}</span>`).join('')}</div></div>`;
  }
  return html;
}

// ---------- History ----------

function addHistory(v) {
  if (!v || v.valid === undefined) return;
  const last = state.history[0];
  if (last && last.word === v.word) return;
  state.history.unshift({ word: v.word, valid: v.valid, t: Date.now() });
  state.history = state.history.slice(0, 100);
  store.set('grabble-history', state.history);
  renderHistory();
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

function renderHistory() {
  $('history-list').innerHTML = state.history.map((h) => `
    <li data-word="${h.word}">
      <span class="dot ${h.valid ? 'valid' : 'invalid'}"></span>
      <span class="word">${h.word}</span>
      <span class="meta">${h.valid ? `${score(h.word)} pts` : 'not valid'}<br>${timeAgo(h.t)}</span>
    </li>`).join('');
  $('history-clear').hidden = !state.history.length;
}

// ---------- Screens ----------

function showScreen(name) {
  state.screen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.screen === name));
  if (name === 'scan') {
    if (state.cameraWanted && !isRunning()) openCamera();
  } else {
    closeSheet();
    stopCamera($('video'));
    state.torch = false;
  }
  if (name === 'type') setTimeout(() => $('word-input').focus(), 200);
  if (name === 'history') renderHistory();
}

// ---------- Camera ----------

async function openCamera() {
  if (!hasCamera()) {
    $('camera-off-msg').textContent = 'Camera isn’t available here. You can still choose a photo of your tiles.';
    $('camera-start').hidden = true;
    $('camera-off').hidden = false;
    return;
  }
  try {
    await startCamera($('video'));
    state.cameraWanted = true;
    $('camera-off').hidden = true;
    $('torch-btn').hidden = !torchSupported();
    $('torch-btn').classList.remove('on');
    getWorker().catch(() => {}); // warm up the reader while the user lines up
  } catch (err) {
    state.cameraWanted = false;
    $('camera-off-msg').textContent = err && err.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it in your browser settings, or choose a photo instead.'
      : 'Couldn’t start the camera. You can still choose a photo of your tiles.';
    $('camera-off').hidden = false;
  }
}

async function scan(canvasPromise) {
  if (state.busy) return;
  state.busy = true;
  $('busy').hidden = false;
  $('busy-msg').textContent = 'Reading tiles…';
  try {
    const canvas = await canvasPromise;
    if (!canvas) throw new Error('No image');
    await state.dictReady;
    const { letters, preview } = await readTiles(canvas);
    if (!letters.length) {
      haptic(40);
      toast('No tiles found. Try getting closer.');
      return;
    }
    openSheet(letters, preview);
  } catch (err) {
    console.error(err);
    toast('Something went wrong reading the tiles');
  } finally {
    state.busy = false;
    $('busy').hidden = true;
  }
}

// ---------- Result sheet ----------

function renderSheet(letters) {
  const v = evaluate(letters);
  // A scan that isn't a word might just be a misread letter. Offer close valid
  // words, but never swap one in silently: the point is to check the tiles.
  const maybe = v && v.kind === 'invalid' ? lookalikeWords(v.word) : [];
  $('sheet-result').innerHTML = `<div class="result">
      <button class="result-tiles editable" id="sheet-tiles" aria-label="Edit letters">${tilesHTML(letters)}</button>
      <div class="edit-hint">Tap the tiles to fix a letter</div>
      ${maybe.length ? `<div class="anagrams"><h4>Misread? Did you mean</h4>
        <div class="chips">${maybe.map((m) => `<button class="chip suggest" data-word="${m}">${m}</button>`).join('')}</div></div>` : ''}
      ${renderVerdict(v)}
    </div>`;
  $('sheet-tiles').onclick = () => startInlineEdit(letters);
  $('sheet-result').querySelectorAll('.suggest').forEach((b) => b.addEventListener('click', () => {
    const next = renderSheet(b.dataset.word.split(''));
    addHistory(next);
    haptic(20);
  }));
  return v;
}

function startInlineEdit(letters) {
  const wrap = $('sheet-tiles');
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = letters.join('').replace(/\?/g, '');
  input.maxLength = 15;
  input.setAttribute('autocapitalize', 'characters');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.spellcheck = false;
  input.enterKeyHint = 'done';
  wrap.replaceWith(input);
  document.querySelector('#sheet-result .edit-hint').textContent = 'Type the letters, then tap Done';
  input.focus();
  const done = () => {
    const next = input.value.toUpperCase().replace(/[^A-Z]/g, '').split('');
    if (!next.length) { renderSheet(letters); return; }
    const v = renderSheet(next);
    addHistory(v);
    haptic(v && v.valid ? 20 : [30, 60, 30]);
  };
  input.addEventListener('blur', done, { once: true });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

function openSheet(letters, preview) {
  const v = renderSheet(letters);
  const seen = $('seen-img');
  seen.innerHTML = '';
  if (preview) seen.appendChild(preview);
  $('seen').open = false;
  $('sheet-backdrop').hidden = false;
  $('sheet').hidden = false;
  addHistory(v);
  haptic(v && v.valid ? 20 : [30, 60, 30]);
}

function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-backdrop').hidden = true;
}

function enableSheetDrag() {
  const sheet = $('sheet');
  let startY = null, dy = 0;
  sheet.addEventListener('touchstart', (e) => {
    if (sheet.scrollTop > 0 || e.target.closest('input')) return;
    startY = e.touches[0].clientY;
    dy = 0;
    sheet.style.transition = 'none';
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (startY == null) return;
    sheet.style.transition = 'transform 0.2s ease';
    if (dy > 110) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => { closeSheet(); sheet.style.transform = ''; sheet.style.transition = ''; }, 200);
    } else {
      sheet.style.transform = '';
    }
    startY = null;
  });
}

// ---------- Type screen ----------

let typeTimer;
function onType() {
  const input = $('word-input');
  const clean = input.value.toUpperCase().replace(/[^A-Z]/g, '');
  if (clean !== input.value) input.value = clean;
  $('word-clear').hidden = !clean;
  const out = $('type-result');
  clearTimeout(typeTimer);
  if (!clean) { out.innerHTML = ''; return; }
  const v = evaluate(clean.split(''));
  out.innerHTML = `<div class="result">${tilesHTML(clean.split(''))}${renderVerdict(v)}</div>`;
  typeTimer = setTimeout(() => addHistory(v), 1500);
}

// ---------- Settings ----------

function renderDictInfo() {
  const info = dictionaryInfo();
  $('dict-name').textContent = info.custom ? info.name : 'ENABLE (built-in)';
  $('dict-count').textContent = `${info.count.toLocaleString()} words`;
  $('dict-reset').hidden = !info.custom;
}

function renderMinLen() {
  $('min-len').textContent = state.minLen;
  store.set('grabble-min-len', state.minLen);
}

// ---------- Wire up ----------

function init() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.screen)));

  $('camera-start').addEventListener('click', openCamera);
  $('shutter').addEventListener('click', () => {
    if (!isRunning()) { openCamera(); return; }
    haptic(10);
    scan(Promise.resolve(captureGuide($('video'), $('guide'))));
  });
  for (const id of ['photo-input', 'photo-input-2']) {
    $(id).addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) scan(fileToCanvas(file));
    });
  }
  $('flip-btn').addEventListener('click', async () => {
    flipCamera();
    if (isRunning()) await openCamera();
  });
  $('torch-btn').addEventListener('click', async () => {
    state.torch = !state.torch;
    try { await setTorch(state.torch); } catch { state.torch = false; }
    $('torch-btn').classList.toggle('on', state.torch);
  });

  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('sheet-again').addEventListener('click', closeSheet);
  enableSheetDrag();

  $('word-input').addEventListener('input', onType);
  $('word-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(typeTimer);
      const clean = $('word-input').value;
      if (clean) addHistory(evaluate(clean.split('')));
      $('word-input').blur();
    }
  });
  $('word-clear').addEventListener('click', () => {
    $('word-input').value = '';
    onType();
    $('word-input').focus();
  });

  $('history-list').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    showScreen('type');
    $('word-input').value = li.dataset.word;
    onType();
  });
  $('history-clear').addEventListener('click', () => {
    if (!confirm('Clear all history?')) return;
    state.history = [];
    store.set('grabble-history', []);
    renderHistory();
  });

  $('min-dec').addEventListener('click', () => { state.minLen = Math.max(2, state.minLen - 1); renderMinLen(); });
  $('min-inc').addEventListener('click', () => { state.minLen = Math.min(8, state.minLen + 1); renderMinLen(); });
  renderMinLen();

  $('dict-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      state.dictReady = importDictionary(file);
      await state.dictReady;
      renderDictInfo();
      onType();
      toast(`Using ${dictionaryInfo().name}`);
    } catch (err) {
      toast(err.message || 'Could not import that file');
      state.dictReady = Promise.resolve();
    }
  });
  $('dict-reset').addEventListener('click', async () => {
    state.dictReady = resetDictionary();
    await state.dictReady;
    renderDictInfo();
    onType();
    toast('Using the built-in dictionary');
  });

  onOcrStatus((s) => {
    const el = $('ocr-status');
    if (s.state === 'loading') el.textContent = `Downloading… ${Math.round((s.progress || 0) * 100)}%`;
    else if (s.state === 'ready') el.textContent = 'Ready, works offline';
    else if (s.state === 'error') el.textContent = 'Couldn’t load. Check your connection.';
  });

  $('version').textContent = `Grabble Checker ${APP_VERSION}`;

  state.dictReady = loadDictionary().then(renderDictInfo).catch((err) => {
    console.error(err);
    $('dict-count').textContent = 'Failed to load';
    toast('Couldn’t load the dictionary');
  });

  renderHistory();
  autoStartCamera();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Download the tile reader in the background so it's ready (and cached for
  // offline use) by the time the first scan happens.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 2500));
  idle(() => getWorker().catch(() => {}), { timeout: 5000 });
}

async function autoStartCamera() {
  // Only start straight away if permission is already granted; otherwise wait
  // for a tap so the browser prompt isn't the first thing people see.
  let granted = false;
  try {
    const p = await navigator.permissions.query({ name: 'camera' });
    granted = p.state === 'granted';
  } catch { /* not supported (e.g. Safari) */ }
  if (granted) openCamera();
  else $('camera-off').hidden = false;
}

init();
