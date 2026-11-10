export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const wrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
export const dampAngle = (a, b, rate, dt) => a + wrap(b - a) * (1 - Math.exp(-rate * dt));
export const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export const rng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const rnd = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];
const h2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
export const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h2(xi, yi), h2(xi + 1, yi), u), lerp(h2(xi, yi + 1), h2(xi + 1, yi + 1), u), v);
};
export const fbm = (x, y) => vnoise(x, y) * 0.55 + vnoise(x * 2.1 + 7.3, y * 2.1 + 1.7) * 0.3 + vnoise(x * 4.3 + 3.1, y * 4.3 + 9.2) * 0.15;
// rotation d'un vecteur local navire -> monde et inverse (cap th, avant = (sin th, cos th))
export const toWorldX = (lx, lz, th) => lx * Math.cos(th) + lz * Math.sin(th);
export const toWorldZ = (lx, lz, th) => -lx * Math.sin(th) + lz * Math.cos(th);
export const toLocalX = (dx, dz, th) => dx * Math.cos(th) - dz * Math.sin(th);
export const toLocalZ = (dx, dz, th) => dx * Math.sin(th) + dz * Math.cos(th);
export const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
