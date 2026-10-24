// Rear camera stream plus cropping the frame to the on-screen guide box.

let stream = null;
let facing = 'environment';

export function hasCamera() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export async function startCamera(video) {
  stopCamera(video);
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  try {
    // Continuous focus helps a lot at close range when supported.
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch { /* not supported */ }
  return track;
}

export function stopCamera(video) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
}

export function isRunning() {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
}

export function flipCamera() {
  facing = facing === 'environment' ? 'user' : 'environment';
}

export function torchSupported() {
  const track = stream && stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  return !!caps.torch;
}

export async function setTorch(on) {
  const track = stream && stream.getVideoTracks()[0];
  if (track) await track.applyConstraints({ advanced: [{ torch: on }] });
}

// Grab the part of the current video frame that sits under `guide` on screen.
// The video uses object-fit: cover, so map screen coords back to video pixels.
export function captureGuide(video, guide) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const vr = video.getBoundingClientRect();
  const gr = guide.getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = (vr.width - vw * scale) / 2;
  const offY = (vr.height - vh * scale) / 2;
  // A little margin so tiles at the very edge of the frame aren't clipped.
  const m = 0.04;
  let sx = (gr.left - vr.left - offX) / scale - (gr.width / scale) * m;
  let sy = (gr.top - vr.top - offY) / scale - (gr.height / scale) * m;
  let sw = (gr.width / scale) * (1 + 2 * m);
  let sh = (gr.height / scale) * (1 + 2 * m);
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);

  const c = document.createElement('canvas');
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

export async function fileToCanvas(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  let src = bitmap;
  if (!src) {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  const w = src.width, h = src.height;
  const k = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
