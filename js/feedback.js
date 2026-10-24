// Sounds (synthesised, so there are no audio files to download) and haptics.

let ctx = null;
let enabled = true;

export function setSoundEnabled(on) {
  enabled = on;
}

// Browsers only allow audio after a user gesture, so create the context then.
export function unlockAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) ctx = new AC();
}

function tone(freq, start, dur, { type = 'sine', gain = 0.18, to } = {}) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function vibrate(pattern) {
  if (navigator.vibrate) try { navigator.vibrate(pattern); } catch { /* ignore */ }
}

export function tap() {
  vibrate(10);
}

// kind: 'valid' | 'invalid' | 'warn'
export function verdictFeedback(kind) {
  if (kind === 'valid') vibrate(25);
  else if (kind === 'invalid') vibrate([30, 60, 30]);
  else vibrate(40);
  if (!enabled || !ctx || ctx.state !== 'running') return;
  if (kind === 'valid') {
    tone(659.25, 0, 0.16);           // E5
    tone(987.77, 0.1, 0.32);         // B5
  } else if (kind === 'invalid') {
    tone(196, 0, 0.16, { type: 'square', gain: 0.07, to: 180 });
    tone(147, 0.17, 0.3, { type: 'square', gain: 0.07, to: 130 });
  } else {
    tone(440, 0, 0.14, { gain: 0.12 });
  }
}
