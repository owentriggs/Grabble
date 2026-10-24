import {
  loadDictionary, importDictionary, resetDictionary, dictionaryInfo,
  isWord, score, anagrams, lookalikeWords, LETTER_POINTS,
} from './dictionary.js';
import { readTiles, getWorker, onOcrStatus } from './ocr.js';
import { lookup } from './define.js';
import { unlockAudio, setSoundEnabled, verdictFeedback, tap } from './feedback.js';
import {
  hasCamera, startCamera, stopCamera, isRunning, flipCamera,
  torchSupported, setTorch, captureGuide, fileToCanvas,
} from './camera.js';

const APP_VERSION = '1.2.0';
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
  sound: store.get('grabble-sound', true),
  bigVerdict: store.get('grabble-big', false),
  defs: store.get('grabble-defs-on', true),
  held: false,       // reading frozen (Hold, editing, or a picked photo)
  fromPhoto: false,
  editing: false,
  reading: false,    // reading a picked photo
  scan: null,        // { letters, preview, photo } shown in the scan panel
};

// Live reading: a result is shown once two reads in a row agree.
const live = { last: '', streak: 0, shown: null };

// ---------- Helpers ----------

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

const esc = (str) => String(str).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
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
    return { kind: 'warn', icon: 'warn', title: 'Check the tiles', text: 'Some tiles couldn’t be read. Tap the tiles to fix them.' };
  }
  if (word.length < state.minLen) {
    return { kind: 'warn', icon: 'warn', title: 'Too short', text: `Words need at least ${state.minLen} letters.`, word };
  }
  if (isWord(word)) {
    return { kind: 'valid', icon: 'check', title: 'Valid word', text: `${word} · ${score(word)} points`, word, valid: true };
  }
  return { kind: 'invalid', icon: 'cross', title: 'Not a word', text: `${word} isn’t in ${dictionaryInfo().name}`, word, valid: false };
}

// ---------- Result panel (shared by Scan and Type) ----------

function renderResult(panel, letters, { scanned = false, preview = null } = {}) {
  const v = evaluate(letters);
  if (!v) return null;
  const maybe = scanned && v.kind === 'invalid' ? lookalikeWords(v.word) : [];
  const same = v.kind === 'invalid' ? anagrams(v.word) : [];
  const tiles = tilesHTML(letters);

  let html = `<div class="sec word-sec">
      ${scanned
    ? `<button class="word-tiles" data-edit aria-label="Edit letters">${tiles}</button>
         <div class="edit-hint">Tap the tiles to fix a letter</div>`
    : `<div class="word-tiles">${tiles}</div>`}
    </div>
    <div class="sec">
      <div class="verdict ${v.kind} pop">
        <div class="badge">${ICONS[v.icon]}</div>
        <div class="v-text"><h2>${v.title}</h2><p>${v.text}</p></div>
        <button class="verdict-expand" data-letters="${letters.join('')}" aria-label="Show full screen">${ICONS.expand}</button>
      </div>
    </div>`;
  if (maybe.length) {
    // A scan that isn't a word may just be a misread letter. Offer close valid
    // words, but never swap one in silently: the point is to check the tiles.
    html += `<div class="sec"><h4 class="sec-label">Misread? Did you mean</h4>
      <div class="words">${maybe.map((m) => `<button data-word="${m}">${m}</button>`).join('')}</div></div>`;
  }
  if (same.length) {
    html += `<div class="sec"><h4 class="sec-label">Same letters, valid words</h4>
      <div class="words">${same.map((a) => `<span>${a}</span>`).join('')}</div></div>`;
  }
  if (v.valid && state.defs) {
    html += `<div class="sec"><h4 class="sec-label">Meaning</h4>
      <div class="definition loading" data-def="${v.word}"></div></div>`;
  }
  if (scanned && preview) {
    html += `<div class="sec"><details class="seen">
        <summary>What the scanner saw</summary>
        <div class="seen-img"></div>
        <button class="text-btn" data-save>Save the photo</button>
        <p class="seen-note">If it misread your tiles, save the photo and send it over so the scanner can be tuned.</p>
      </details></div>`;
  }
  panel.innerHTML = html;
  if (scanned && preview) panel.querySelector('.seen-img').appendChild(preview);
  panel.scrollTop = 0;
  return v;
}

function renderEmpty(panel, text) {
  panel.innerHTML = `<div class="panel-empty"><p>${text}</p></div>`;
}

// ---------- Definitions ----------

function renderDefinition(el, result) {
  el.classList.remove('loading');
  if (!result.entries.length) {
    el.classList.add('quiet');
    el.textContent = 'No definition found online. It’s still a valid word.';
    return;
  }
  el.innerHTML = `${result.entries.map((e) => `
    ${e.pos ? `<div class="pos">${esc(e.pos)}</div>` : ''}
    <ol>${e.defs.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>`).join('')}
    <div class="src">From ${esc(result.source)}</div>`;
}

function fillDefinitions(container) {
  container.querySelectorAll('.definition[data-def]').forEach((el) => {
    lookup(el.dataset.def).then((result) => {
      if (el.isConnected) renderDefinition(el, result);
    }).catch(() => {
      if (!el.isConnected) return;
      el.classList.remove('loading');
      el.classList.add('quiet');
      el.textContent = navigator.onLine
        ? 'Couldn’t look up the meaning right now.'
        : 'Connect to the internet to see what it means.';
    });
  });
}

// ---------- Full-screen verdict ----------

const BIG_TITLES = { valid: 'Valid!', invalid: 'Not a word' };

function showBig(letters) {
  const v = evaluate(letters);
  if (!v) return;
  const big = $('big');
  big.className = `big ${v.kind}`;
  $('big-badge').innerHTML = ICONS[v.icon];
  $('big-title').textContent = BIG_TITLES[v.kind] || v.title;
  $('big-tiles').innerHTML = tilesHTML(letters);
  $('big-text').textContent = v.valid ? `${score(v.word)} points` : v.kind === 'warn' ? v.text : '';
  big.hidden = false;
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
    <li class="row" data-word="${h.word}">
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
    stopCamera($('video'));
    state.torch = false;
    $('torch-btn').classList.remove('on');
    updateStatus();
  }
  if (name === 'type') setTimeout(() => $('word-input').focus(), 150);
  if (name === 'history') renderHistory();
}

// ---------- Scan screen ----------

function updateStatus() {
  const status = $('status');
  const running = isRunning();
  status.classList.toggle('held', state.held);
  status.classList.toggle('off', !state.held && !running);
  $('status-text').textContent = state.held ? (state.fromPhoto ? 'Photo' : 'Held') : running ? 'Live' : 'Off';
  $('hold-btn').setAttribute('aria-pressed', String(state.held));
  $('hold-label').textContent = state.held ? 'Resume' : 'Hold';
  $('hold-btn').hidden = !running && !state.held;
}

function renderScan() {
  const panel = $('scan-panel');
  if (state.reading) { renderEmpty(panel, 'Reading the photo…'); return null; }
  if (!state.scan) {
    renderEmpty(panel, isRunning() || state.cameraWanted
      ? 'Point the camera at a row of tiles. The result shows here as soon as they’re read.'
      : 'Turn on the camera, or pick a photo of your tiles.');
    return null;
  }
  const v = renderResult(panel, state.scan.letters, { scanned: true, preview: state.scan.preview });
  fillDefinitions(panel);
  return v;
}

function showScanResult(letters, preview, photo) {
  state.scan = { letters, preview, photo };
  const v = renderScan();
  if (v) verdictFeedback(v.kind);
  return v;
}

async function openCamera() {
  if (!hasCamera()) {
    $('camera-off-msg').textContent = 'Camera isn’t available here. You can still pick a photo of your tiles.';
    $('camera-start').hidden = true;
    $('camera-off').hidden = false;
    renderScan();
    return;
  }
  try {
    await startCamera($('video'));
    state.cameraWanted = true;
    $('camera-off').hidden = true;
    $('torch-btn').hidden = !torchSupported();
    $('torch-btn').classList.remove('on');
    getWorker().catch(() => {});
  } catch (err) {
    state.cameraWanted = false;
    $('camera-off-msg').textContent = err && err.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it in your browser settings, or pick a photo instead.'
      : 'Couldn’t start the camera. You can still pick a photo of your tiles.';
    $('camera-off').hidden = false;
  }
  updateStatus();
  renderScan();
}

// Freeze (or unfreeze) what's on screen so the result stops changing.
function setHold(on, { fromPhoto = false } = {}) {
  state.held = on;
  state.fromPhoto = on && fromPhoto;
  const still = $('still');
  if (on && !fromPhoto) {
    const video = $('video');
    if (video.videoWidth) {
      still.width = video.videoWidth;
      still.height = video.videoHeight;
      still.getContext('2d').drawImage(video, 0, 0);
      still.hidden = false;
    }
  }
  if (!on) {
    still.hidden = true;
    live.last = '';
    live.streak = 0;
    live.shown = state.scan ? state.scan.letters.join('') : null;
  }
  updateStatus();
}

function holdCurrent() {
  setHold(true);
  if (!state.scan) return;
  const v = evaluate(state.scan.letters);
  addHistory(v);
  if (v && state.bigVerdict) showBig(state.scan.letters);
}

async function readPhoto(file) {
  setHold(true, { fromPhoto: true });
  $('camera-off').hidden = true;
  state.reading = true;
  renderScan();
  try {
    const canvas = await fileToCanvas(file);
    const still = $('still');
    still.width = canvas.width;
    still.height = canvas.height;
    still.getContext('2d').drawImage(canvas, 0, 0);
    still.hidden = false;
    await state.dictReady;
    const { letters, preview } = await readTiles(canvas);
    state.reading = false;
    if (!letters.length) {
      state.scan = null;
      renderEmpty($('scan-panel'), 'No tiles found in that photo. Try a closer shot of a single row.');
      verdictFeedback('warn');
      return;
    }
    const v = showScanResult(letters, preview, canvas);
    addHistory(v);
    if (v && state.bigVerdict) showBig(letters);
  } catch (err) {
    console.error(err);
    state.reading = false;
    renderEmpty($('scan-panel'), 'Couldn’t read that photo.');
  }
}

async function liveTick() {
  const ready = state.screen === 'scan' && isRunning() && !state.held && !state.editing
    && $('big').hidden && document.visibilityState === 'visible';
  if (ready) {
    const crop = captureGuide($('video'), $('guide'));
    if (crop) {
      try {
        const result = await readTiles(crop);
        if (!state.held && !state.editing) onLiveRead(result, crop);
      } catch { /* try again next tick */ }
    }
  }
  setTimeout(liveTick, ready ? 150 : 500);
}

function onLiveRead({ letters, preview }, crop) {
  const word = letters.join('');
  live.streak = word === live.last ? live.streak + 1 : 1;
  live.last = word;
  if (!word) return; // keep the last result up while the camera moves around
  // Log a reading to history once it has held steady for a moment.
  if (live.streak === 4 && word === live.shown) addHistory(evaluate(letters));
  if (live.streak < 2 || word === live.shown) return;
  live.shown = word;
  showScanResult(letters, preview, crop);
}

function startInlineEdit() {
  const wrap = $('scan-panel').querySelector('[data-edit]');
  if (!wrap || !state.scan) return;
  if (!state.held) setHold(true);
  state.editing = true;
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = state.scan.letters.join('').replace(/\?/g, '');
  input.maxLength = 15;
  input.setAttribute('autocapitalize', 'characters');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.spellcheck = false;
  input.enterKeyHint = 'done';
  wrap.replaceWith(input);
  $('scan-panel').querySelector('.edit-hint').textContent = 'Type the letters, then tap Done';
  input.focus();
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
  input.addEventListener('blur', () => {
    state.editing = false;
    const next = input.value.split('').filter(Boolean);
    if (!next.length) { renderScan(); return; }
    const v = showScanResult(next, state.scan.preview, state.scan.photo);
    addHistory(v);
  }, { once: true });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

async function savePhoto() {
  const canvas = state.scan && state.scan.photo;
  if (!canvas) return;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  const file = new File([blob], `grabble-scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Grabble scan' }); return; } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Type screen ----------

let typeTimer, defTimer;
function onType() {
  const input = $('word-input');
  const clean = input.value.toUpperCase().replace(/[^A-Z]/g, '');
  if (clean !== input.value) input.value = clean;
  $('word-clear').hidden = !clean;
  const panel = $('type-panel');
  clearTimeout(typeTimer);
  clearTimeout(defTimer);
  if (!clean) { renderEmpty(panel, 'Type a word to check it. The result updates as you type.'); return; }
  const v = renderResult(panel, clean.split(''));
  // Wait for a pause in typing before looking up a meaning or logging it.
  defTimer = setTimeout(() => fillDefinitions(panel), 500);
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

// Settings change results, so redraw whatever is showing.
function refreshResults() {
  if (state.scan) renderScan();
  onType();
}

// ---------- Wire up ----------

function init() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.screen)));

  $('camera-start').addEventListener('click', openCamera);
  $('hold-btn').addEventListener('click', () => {
    tap();
    if (state.held) {
      setHold(false);
      if (!isRunning()) {
        if (state.cameraWanted) openCamera();
        else $('camera-off').hidden = false;
      }
    } else {
      holdCurrent();
    }
  });
  for (const id of ['photo-input', 'photo-input-2']) {
    $(id).addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) readPhoto(file);
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

  $('scan-panel').addEventListener('click', (e) => {
    if (e.target.closest('[data-edit]')) { startInlineEdit(); return; }
    if (e.target.closest('[data-save]')) { savePhoto(); return; }
    const suggestion = e.target.closest('button[data-word]');
    if (suggestion) {
      if (!state.held) setHold(true);
      const v = showScanResult(suggestion.dataset.word.split(''), state.scan.preview, state.scan.photo);
      addHistory(v);
    }
  });

  // Expand any verdict to full screen; tap the overlay to close it.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.verdict-expand');
    if (btn) showBig(btn.dataset.letters.split(''));
  });
  $('big').addEventListener('click', () => { $('big').hidden = true; });

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

  $('min-dec').addEventListener('click', () => { state.minLen = Math.max(2, state.minLen - 1); renderMinLen(); refreshResults(); });
  $('min-inc').addEventListener('click', () => { state.minLen = Math.min(8, state.minLen + 1); renderMinLen(); refreshResults(); });
  renderMinLen();

  // Browsers only allow sound after the user has touched the page.
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  setSoundEnabled(state.sound);
  for (const [id, key, prop] of [
    ['opt-sound', 'grabble-sound', 'sound'],
    ['opt-big', 'grabble-big', 'bigVerdict'],
    ['opt-defs', 'grabble-defs-on', 'defs'],
  ]) {
    $(id).checked = state[prop];
    $(id).addEventListener('change', (e) => {
      state[prop] = e.target.checked;
      store.set(key, state[prop]);
      setSoundEnabled(state.sound);
      if (prop === 'defs') refreshResults();
    });
  }

  $('dict-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      state.dictReady = importDictionary(file);
      await state.dictReady;
      renderDictInfo();
      refreshResults();
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
    refreshResults();
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
  onType();
  updateStatus();
  renderScan();
  autoStartCamera();
  liveTick();

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
