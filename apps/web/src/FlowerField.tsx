import { useEffect, useRef } from 'react';

/**
 * A stippled lily. The petal outline and shading are traced from the reference
 * illustration into /flower-density.png (see scripts/make-flower-map.py); this
 * component scatters fine ink dots according to that map. Under the pointer the
 * stipple dissolves into density-mapped ASCII glyphs, then eases back.
 */

const MAP_URL = '/flower-density.png';
const RAMP = ['·', ':', '+', '=', '*', '‡', '#', '▪'];
const CELL = 10; // glyph grid, px
const PITCH = 2.1; // stipple grid, px
const RADIUS = 130; // reveal radius, px

type Cell = { x: number; y: number; d: number; t: number; ch: number };
type DensityMap = { w: number; h: number; data: Uint8ClampedArray };

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
function hash(i: number, j: number, k = 0) {
  const s = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

let mapPromise: Promise<DensityMap> | null = null;
function loadMap(): Promise<DensityMap> {
  mapPromise ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(img, 0, 0);
      // grayscale PNG → red channel carries the density
      resolve({ w: c.width, h: c.height, data: x.getImageData(0, 0, c.width, c.height).data });
    };
    img.onerror = reject;
    img.src = MAP_URL;
  });
  return mapPromise;
}

function sample(m: DensityMap, u: number, v: number) {
  const x = Math.floor(u * m.w), y = Math.floor(v * m.h);
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return 0;
  return m.data[(y * m.w + x) * 4] / 255;
}

export function FlowerField() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = wrap.current!, cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim() || '#0d0d0d';
    const paper = css.getPropertyValue('--paper').trim() || '#eeedea';
    const mono = css.getPropertyValue('--font-mono').trim() || 'monospace';

    let map: DensityMap | null = null;
    let cells: Cell[] = [];
    let w = 0, h = 0, dpr = 1, raf = 0, dead = false;
    let still: HTMLCanvasElement | null = null;
    const ptr = { x: -9999, y: -9999, in: false };

    function build() {
      if (!map) return;
      dpr = Math.min(2, devicePixelRatio || 1);
      w = el.clientWidth; h = el.clientHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;

      // fit the map's aspect inside the box, centred
      const aspect = map.w / map.h;
      const sh = Math.min(h, w / aspect), sw = sh * aspect;
      const ox = (w - sw) / 2, oy = (h - sh) / 2;
      const D = (x: number, y: number) => sample(map!, (x - ox) / sw, (y - oy) / sh);

      // 1. stipple layer, rendered once
      still = document.createElement('canvas');
      still.width = w * dpr; still.height = h * dpr;
      const sc = still.getContext('2d')!;
      sc.scale(dpr, dpr);
      sc.fillStyle = ink;
      const cols = Math.floor(w / PITCH), rows = Math.floor(h / PITCH);
      sc.beginPath();
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = (i + 0.15 + 0.7 * hash(i, j, 1)) * PITCH;
          const y = (j + 0.15 + 0.7 * hash(i, j, 2)) * PITCH;
          const d = D(x, y);
          if (d > 0.03 && hash(i, j, 5) < Math.pow(d, 1.05) * 0.9) {
            sc.moveTo(x + 0.95, y);
            sc.arc(x, y, 0.95, 0, Math.PI * 2);
          }
        }
      }
      sc.fill();

      // 2. glyph grid, revealed under the pointer
      cells = [];
      const gc = Math.floor(w / CELL), gr = Math.floor(h / CELL);
      const gx = (w - gc * CELL) / 2 + CELL / 2, gy = (h - gr * CELL) / 2 + CELL / 2;
      for (let j = 0; j < gr; j++) {
        for (let i = 0; i < gc; i++) {
          const x = gx + i * CELL, y = gy + j * CELL;
          let d = 0, n = 0;
          for (let a = -1; a <= 1; a += 2) for (let b = -1; b <= 1; b += 2) { d += D(x + a * CELL * 0.3, y + b * CELL * 0.3); n++; }
          d /= n;
          if (d > 0.06) cells.push({ x, y, d, t: 0, ch: Math.min(RAMP.length - 1, Math.floor(d * RAMP.length)) });
        }
      }
      draw();
    }

    function draw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (still) ctx.drawImage(still, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `500 ${CELL + 1}px ${mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const c of cells) {
        if (c.t < 0.02) continue;
        // dissolve the stipple under this cell, then print the glyph
        ctx.globalAlpha = Math.min(1, c.t * 1.2);
        ctx.fillStyle = paper;
        ctx.fillRect(c.x - CELL / 2 - 0.5, c.y - CELL / 2 - 0.5, CELL + 1, CELL + 1);
        ctx.globalAlpha = c.t * (0.4 + 0.6 * c.d);
        ctx.fillStyle = ink;
        ctx.fillText(RAMP[c.ch], c.x, c.y);
      }
      ctx.globalAlpha = 1;
    }

    function tick() {
      let moving = false;
      for (const c of cells) {
        const dist = Math.hypot(c.x - ptr.x, c.y - ptr.y);
        const target = ptr.in ? clamp(1.4 - dist / RADIUS) : 0;
        const next = reduce ? target : c.t + (target - c.t) * (target > c.t ? 0.25 : 0.06);
        if (Math.abs(next - c.t) > 0.004) moving = true;
        c.t = Math.abs(next - target) < 0.004 ? target : next;
        const base = Math.floor(c.d * RAMP.length);
        if (!reduce && c.t > 0.05 && c.t < 0.9 && Math.random() < 0.08) {
          c.ch = clamp(base + Math.floor(Math.random() * 3) - 1, 0, RAMP.length - 1);
        } else if (c.t >= 0.9) {
          c.ch = Math.min(RAMP.length - 1, base);
        }
      }
      draw();
      raf = moving || ptr.in ? requestAnimationFrame(tick) : 0;
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

    const move = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; ptr.in = true;
      kick();
    };
    const leave = () => { ptr.in = false; kick(); };
    const up = (e: PointerEvent) => { if (e.pointerType !== 'mouse') leave(); };

    const ro = new ResizeObserver(build);
    ro.observe(el);
    loadMap().then((m) => { if (!dead) { map = m; build(); } }).catch(() => {});
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerdown', move);
    cv.addEventListener('pointerleave', leave);
    cv.addEventListener('pointerup', up);
    document.fonts?.ready.then(draw);
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerdown', move);
      cv.removeEventListener('pointerleave', leave);
      cv.removeEventListener('pointerup', up);
    };
  }, []);

  return (
    <div ref={wrap} className="flower" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
