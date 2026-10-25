// Reads Scrabble tiles from an image.
//
// Tesseract on its own does poorly on a raw photo of tiles: the point values,
// tile edges and shadows all get read as letters. So we first find the letter
// shapes ourselves (adaptive threshold + connected components), throw away
// anything that isn't letter-sized (the small point digits, edges, specks),
// and redraw just the letters as clean black-on-white glyphs in a neat row.
// Tesseract then only has to read that tidy line.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GLYPH_H = 64;
const MAX_SIDE = 1400;

let workerPromise = null;
let statusListener = () => {};

export function onOcrStatus(fn) {
  statusListener = fn;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// On a first visit, wait (briefly) for the service worker to take control so
// the engine files it downloads get cached for offline use.
function swControlling() {
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) return Promise.resolve();
  return Promise.race([
    new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
}

export function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      statusListener({ state: 'loading', progress: 0 });
      await swControlling();
      if (!window.Tesseract) await loadScript('vendor/tesseract/tesseract.min.js');
      const base = new URL('vendor/tesseract/', document.baseURI).href;
      const worker = await window.Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'core/',
        langPath: base + 'lang/',
        workerBlobURL: false,
        gzip: true,
        logger: (m) => {
          if (m.status && m.status.startsWith('loading')) {
            statusListener({ state: 'loading', progress: m.progress || 0 });
          }
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist: LETTERS,
        tessedit_pageseg_mode: '7',
      });
      statusListener({ state: 'ready' });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      statusListener({ state: 'error', error: err });
      throw err;
    });
  }
  return workerPromise;
}

// ---------- Image processing ----------

function toGray(img) {
  const { data, width, height } = img;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    g[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return g;
}

// Local mean brightness around every pixel (box filter via an integral image).
function localMeans(gray, w, h) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const half = Math.max(8, Math.round(Math.min(w, h) / 6));
  const means = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1]
        - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      means[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return means;
}

// Bradley–Roth adaptive threshold. Returns 1 for "ink" pixels.
function threshold(gray, means, darkInk) {
  const t = 0.15;
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i], m = means[i];
    out[i] = darkInk ? (v < m * (1 - t) ? 1 : 0) : (v > m * (1 + t) ? 1 : 0);
  }
  return out;
}

// How strongly a pixel stands out from its surroundings, as a fraction.
const contrastAt = (gray, means, i, darkInk) => (darkInk
  ? (means[i] - gray[i]) / Math.max(1, means[i])
  : (gray[i] - means[i]) / Math.max(1, 255 - means[i]));

function components(bin, w, h, contrast) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  let next = 1;
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || labels[start]) continue;
    const id = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0, cSum = 0, edge = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      area++;
      cSum += contrast(p);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1
        || !bin[p - 1] || !bin[p + 1] || !bin[p - w] || !bin[p + w]) edge++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (bin[q] && !labels[q]) {
            labels[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    comps.push({
      ids: [id], x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area,
      contrast: cSum / area,
      stroke: (2 * area) / edge, // rough stroke width
    });
  }
  return { labels, comps };
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

// Merge pieces that overlap horizontally (a letter split by glare).
function mergeRow(row) {
  row.sort((a, b) => a.x - b.x);
  const merged = [];
  for (const c of row) {
    const last = merged[merged.length - 1];
    if (last) {
      const overlap = Math.min(last.x + last.w, c.x + c.w) - Math.max(last.x, c.x);
      if (overlap > Math.min(last.w, c.w) * 0.6) {
        const x = Math.min(last.x, c.x), y = Math.min(last.y, c.y);
        last.w = Math.max(last.x + last.w, c.x + c.w) - x;
        last.h = Math.max(last.y + last.h, c.y + c.h) - y;
        last.x = x; last.y = y;
        last.area += c.area;
        last.ids.push(...c.ids);
        continue;
      }
    }
    merged.push({ ...c, ids: [...c.ids] });
  }
  return merged;
}

// Returns { rows: [[glyph, ...], ...], slope }. With multiRow, tiles laid out
// in several rows are all kept, top to bottom; otherwise just the one line.
function pickLetters(comps, w, h, multiRow) {
  const minArea = Math.max(40, w * h * 0.00003);
  let cand = comps.filter((c) =>
    c.area >= minArea
    && c.x > 1 && c.y > 1 && c.x + c.w < w - 1 && c.y + c.h < h - 1 // touches crop edge
    && c.h >= Math.max(12, h * (multiRow ? 0.012 : 0.02)) && c.h <= h * 0.92
    && c.w <= c.h * 2.2
    && c.area / (c.w * c.h) >= 0.12 // hollow outlines (tile edges)
    && c.contrast >= 0.3 // printed letters stand out far more than wood grain or carpet
    && c.stroke >= Math.max(2.5, c.h * 0.09)); // and have thick strokes, unlike speckle and texture
  if (!cand.length) return { rows: [], slope: 0 };

  // Letters are the most contrasty things in the shot, so anything much weaker
  // than the strongest blobs is texture. Relative, so dim photos still work.
  const strong = [...cand].sort((a, b) => b.contrast - a.contrast);
  const minContrast = strong[Math.min(strong.length - 1, 2)].contrast * 0.6;
  cand = cand.filter((c) => c.contrast >= minContrast);

  // Letter height: the height band carrying the most "mass". Point digits are
  // about a third of the letter height, so letters win even though each tile
  // has both.
  let ref = 0, best = -1;
  for (const c of cand) {
    let s = 0;
    for (const d of cand) if (d.h >= c.h * 0.8 && d.h <= c.h * 1.25) s += d.h;
    if (s > best || (s === best && c.h > ref)) { best = s; ref = c.h; }
  }
  let keep = cand.filter((c) => c.h >= ref * 0.62 && c.h <= ref * 1.45);

  // Keep things on one (possibly tilted) line. Theil–Sen fit: the median of
  // pairwise slopes shrugs off the odd stray blob. With several rows, only
  // pairs that look like neighbours on the same row count.
  const cx = (c) => c.x + c.w / 2, cy = (c) => c.y + c.h / 2;
  const slopes = [];
  for (let i = 0; i < keep.length; i++) {
    for (let j = i + 1; j < keep.length; j++) {
      const dx = cx(keep[j]) - cx(keep[i]);
      const dy = cy(keep[j]) - cy(keep[i]);
      if (multiRow && Math.abs(dy) > Math.abs(dx) * 0.5) continue;
      if (Math.abs(dx) > ref * 0.5) slopes.push(dy / dx);
    }
  }
  const slope = Math.max(-0.5, Math.min(0.5, median(slopes)));
  const offset = (c) => cy(c) - slope * cx(c);

  if (!multiRow) {
    const icpt = median(keep.map(offset));
    keep = keep.filter((c) => Math.abs(offset(c) - icpt) <= ref * 0.7);
    return { rows: [mergeRow(keep)], slope };
  }

  // Split into rows wherever there's a clear gap between letter centres.
  keep.sort((a, b) => offset(a) - offset(b));
  const rows = [];
  let prev = -Infinity;
  for (const c of keep) {
    if (offset(c) - prev > ref * 0.55) rows.push([]);
    rows[rows.length - 1].push(c);
    prev = offset(c);
  }
  return { rows: rows.map(mergeRow), slope };
}

function glyphCanvas(labels, w, glyph, scale) {
  const gw = Math.max(1, Math.round(glyph.w * scale));
  const gh = Math.max(1, Math.round(glyph.h * scale));
  const src = document.createElement('canvas');
  src.width = glyph.w;
  src.height = glyph.h;
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(glyph.w, glyph.h);
  const ids = new Set(glyph.ids);
  for (let y = 0; y < glyph.h; y++) {
    for (let x = 0; x < glyph.w; x++) {
      const on = ids.has(labels[(glyph.y + y) * w + glyph.x + x]);
      const i = (y * glyph.w + x) * 4;
      const v = on ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = gw;
  out.height = gh;
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(src, 0, 0, gw, gh);
  return out;
}

function padded(canvas, pad) {
  const c = document.createElement('canvas');
  c.width = canvas.width + pad * 2;
  c.height = canvas.height + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, pad, pad);
  return c;
}

const countOf = (found) => (found ? found.rows.reduce((n, r) => n + r.length, 0) : 0);

function findLetters(canvas, multiRow) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const gray = toGray(ctx.getImageData(0, 0, w, h));
  const means = localMeans(gray, w, h);
  for (const darkInk of [true, false]) {
    const contrast = (i) => contrastAt(gray, means, i, darkInk);
    const { labels, comps } = components(threshold(gray, means, darkInk), w, h, contrast);
    const { rows, slope } = pickLetters(comps, w, h, multiRow);
    if (rows.length) return { labels, rows, slope, w };
  }
  return null;
}

function rotated(canvas, angle) {
  const { width: w, height: h } = canvas;
  const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
  const c = document.createElement('canvas');
  c.width = Math.round(w * cos + h * sin);
  c.height = Math.round(w * sin + h * cos);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // Fill the new corners with a blurred copy so they don't create hard edges.
  ctx.filter = 'blur(20px)';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  ctx.filter = 'none';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(angle);
  ctx.drawImage(canvas, -w / 2, -h / 2);
  return c;
}

// Draw glyph canvases side by side as one clean line of text.
function lineCanvas(canvases) {
  const gap = Math.round(GLYPH_H * 0.45);
  const pad = Math.round(GLYPH_H * 0.5);
  const line = document.createElement('canvas');
  line.width = canvases.reduce((s, g) => s + g.width, 0) + gap * (canvases.length - 1) + pad * 2;
  line.height = Math.max(...canvases.map((g) => g.height)) + pad * 2;
  const lctx = line.getContext('2d');
  lctx.fillStyle = '#fff';
  lctx.fillRect(0, 0, line.width, line.height);
  let x = pad;
  for (const g of canvases) {
    // Align glyph bottoms on a baseline.
    lctx.drawImage(g, x, line.height - pad - g.height);
    x += g.width + gap;
  }
  return line;
}

// Find letter glyphs in a canvas. Returns one { glyphs, bars, line } per row
// of tiles (at most one unless multiRow). Exposed for testing.
export function segment(source, { multiRow = false } = {}) {
  let w = source.width, h = source.height;
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.round(w * k); h = Math.round(h * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, w, h);

  let found = findLetters(c, multiRow);
  // If the rows are tilted, straighten the photo and look again.
  if (countOf(found) >= 2 && Math.abs(found.slope) > 0.03) {
    const again = findLetters(rotated(c, -Math.atan(found.slope)), multiRow);
    if (countOf(again) >= countOf(found)) found = again;
  }
  if (!found) return [];

  const { labels } = found;
  const ref = median(found.rows.flat().map((g) => g.h));
  const scale = GLYPH_H / ref;
  return found.rows.map((row) => {
    const glyphs = row.map((g) => glyphCanvas(labels, found.w, g, scale));
    // A solid narrow bar can only be an I. Tesseract often drops a lone bar, so
    // we decide those ourselves.
    const bars = row.map((g) => g.w / g.h < 0.3 && g.area / (g.w * g.h) > 0.75);
    return { glyphs, bars, line: lineCanvas(glyphs) };
  });
}

// Stack each row's clean line into one picture of what the scanner saw.
function stacked(lines) {
  if (lines.length === 1) return lines[0];
  const out = document.createElement('canvas');
  out.width = Math.max(...lines.map((l) => l.width));
  out.height = lines.reduce((s, l) => s + l.height, 0);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const l of lines) { ctx.drawImage(l, 0, y); y += l.height; }
  return out;
}

// Reads run one at a time (live scanning and the shutter share one engine,
// and a read changes its settings part-way through).
let queue = Promise.resolve();

// Returns { letters: ['C','A','T'] (with '?' for unreadable), rows: [['C','A','T']],
// preview: canvas }. With multiRow, every row of tiles in the shot is read.
export function readTiles(source, opts) {
  const run = queue.then(() => readNow(source, opts));
  queue = run.catch(() => {});
  return run;
}

async function readRow(worker, { glyphs, bars, line }) {
  const { data } = await worker.recognize(line);
  const text = (data.text || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (text.length === glyphs.length) return text.split('').map((ch, i) => (bars[i] ? 'I' : ch));

  // The line read didn't line up with the glyphs we found, so read them one by one.
  await worker.setParameters({ tessedit_pageseg_mode: '10' });
  const letters = [];
  for (const [i, g] of glyphs.entries()) {
    if (bars[i]) { letters.push('I'); continue; }
    const r = await worker.recognize(padded(g, Math.round(GLYPH_H * 0.4)));
    const ch = (r.data.text || '').toUpperCase().replace(/[^A-Z]/g, '');
    letters.push(ch[0] || '?');
  }
  await worker.setParameters({ tessedit_pageseg_mode: '7' });
  return letters;
}

async function readNow(source, opts) {
  const found = segment(source, opts);
  if (!found.length) return { letters: [], rows: [], preview: null };

  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '7' });
  const rows = [];
  for (const row of found) rows.push(await readRow(worker, row));
  return { letters: rows.flat(), rows, preview: stacked(found.map((r) => r.line)) };
}
