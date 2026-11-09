// Everything dithered in the app comes from this one 8x8 Bayer threshold matrix:
// animated canvas fields, static CSS tiles, and the dissolve masks on elements.

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const colors = {
  get ink() { return css('--ink'); },
  get accent() { return css('--accent'); },
};

// Canvas pixels map to a whole number of device pixels, so the grain stays even at 125% or 150% scaling.
const deviceCell = (cell) => Math.max(1, Math.round(cell * devicePixelRatio));

// ImageData is little-endian: 0xAABBGGRR.
function toPixel(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
}

const fields = new Set();
let running = false;

function tick(now) {
  requestAnimationFrame(tick);
  if (document.hidden) return;
  for (const f of fields) f.step(now);
}

function ensureLoop() {
  if (running) return;
  running = true;
  requestAnimationFrame(tick);
}

// Draws shade(x, y, time, width, height) -> 0..1 density as ordered dither.
export function field(canvas, { cell = 3, fps = 10, color, shade, frame }) {
  const ctx = canvas.getContext('2d');
  const host = canvas.parentElement;
  let img, buf;
  let pixel = toPixel(color);
  let last = -Infinity;
  let dirty = true;
  let seen = false;

  const resize = () => {
    const box = host === document.body ? { width: innerWidth, height: innerHeight } : host.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dev = deviceCell(cell);
    const w = Math.ceil((box.width * devicePixelRatio) / dev);
    const h = Math.ceil((box.height * devicePixelRatio) / dev);
    if (w === canvas.width && h === canvas.height && img) return;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${(w * dev) / devicePixelRatio}px`;
    canvas.style.height = `${(h * dev) / devicePixelRatio}px`;
    img = ctx.createImageData(w, h);
    buf = new Uint32Array(img.data.buffer);
    dirty = true;
  };

  const observer = new ResizeObserver(resize);
  observer.observe(host === document.body ? document.documentElement : host);

  const self = {
    step(now) {
      if (!canvas.isConnected) {
        if (seen) self.stop();
        return;
      }
      seen = true;
      if (!img) resize();
      if (!img) return;
      if (reducedMotion ? !dirty : now - last < 1000 / fps) return;
      last = now;
      dirty = false;
      const t = reducedMotion ? 0 : now / 1000;
      const { width: w, height: h } = canvas;
      frame?.(t, w, h);
      let i = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          buf[i++] = shade(x, y, t, w, h) * 64 > BAYER[((y & 7) << 3) | (x & 7)] ? pixel : 0;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    setColor(hex) {
      pixel = toPixel(hex);
      dirty = true;
    },
    invalidate() { dirty = true; },
    stop() {
      observer.disconnect();
      fields.delete(self);
    },
  };

  fields.add(self);
  ensureLoop();
  return self;
}

function tile(width, height, on, color) {
  const dev = deviceCell(2);
  const c = document.createElement('canvas');
  c.width = width * dev;
  c.height = height * dev;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (on(x, y, BAYER[((y & 7) << 3) | (x & 7)])) ctx.fillRect(x * dev, y * dev, dev, dev);
    }
  }
  return `url(${c.toDataURL()})`;
}

const LEVELS = 16;
const masks = [];
let maskSize = '16px 16px';

export function installTiles() {
  const root = document.documentElement.style;
  const ink = colors.ink;
  const size = (8 * deviceCell(2)) / devicePixelRatio;
  maskSize = `${size}px ${size}px`;
  root.setProperty('--tile', `${size}px`);
  root.setProperty('--t-12', tile(8, 8, (x, y, b) => b < 8, ink));
  root.setProperty('--t-50', tile(8, 8, (x, y, b) => b < 32, ink));
  root.setProperty('--t-fade', tile(48, 8, (x, y, b) => b < (x / 47) ** 1.6 * 64, ink));
  for (let level = 0; level <= LEVELS; level++) {
    masks.push(tile(8, 8, (x, y, b) => b < (level / LEVELS) * 64, '#000'));
  }
}

const clearMask = (el) => {
  el.style.maskImage = el.style.webkitMaskImage = '';
  el.style.maskSize = el.style.webkitMaskSize = '';
};

// Fades an element in or out through the dither levels instead of through opacity.
export function dissolve(el, direction = 'in', ms = 240) {
  if (reducedMotion) return Promise.resolve();
  return new Promise((resolve) => {
    const start = performance.now();
    let shown = -1;
    el.style.maskSize = el.style.webkitMaskSize = maskSize;
    const step = (now) => {
      const p = Math.min(1, (now - start) / ms);
      const level = Math.round((direction === 'in' ? p : 1 - p) * LEVELS);
      if (level !== shown) {
        shown = level;
        el.style.maskImage = el.style.webkitMaskImage = masks[level];
      }
      if (p < 1) return requestAnimationFrame(step);
      if (direction === 'in') clearMask(el);
      resolve();
    };
    step(start);
  });
}
