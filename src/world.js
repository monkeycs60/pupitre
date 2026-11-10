import { THREE } from './three.js';
import { G, emit } from './state.js';
import { fbm, smooth, lerp, rng, TAU, dist, clamp } from './util.js';
import { prim, builder, part, raw, bake, mesh, MAT, lin } from './geo.js';
import { ISLANDS, WRECKS, DROPS, WORLD } from './config.js';
import { waveH } from './ocean.js';

export const islands = [];
export const interactables = []; // étals du port
export const chests = [];
export const wrecks = [];
export const shipCircles = []; // obstacles fixes pour les navires
export const seaPickups = [];
export const groundPickups = [];
export const fires = []; // feux de camp (particules)
const PIER_Y = 1.5;

export const radiusAt = (isl, ang) => isl.r * (1 + 0.1 * Math.sin(3 * ang + isl.p1) + 0.06 * Math.sin(5 * ang + isl.p2));

export const terrainH = (isl, x, z) => {
  const dx = x - isl.x, dz = z - isl.z, d = Math.hypot(dx, dz);
  if (d > isl.r * 1.7) return -9;
  const s = 1 - d / radiusAt(isl, Math.atan2(dx, dz));
  let h;
  if (s < 0) h = Math.max(-9, s * 32);
  else if (s < 0.22) h = s * 8;
  else h = 1.76 + (s - 0.22) * isl.hillK + (fbm(x * 0.035 + isl.seed, z * 0.035) - 0.3) * isl.hillAmp * smooth(0.22, 0.5, s);
  for (let i = 0; i < isl.flats.length; i++) {
    const f = isl.flats[i], w = smooth(f.r, f.r * 0.6, Math.hypot(x - f.x, z - f.z));
    if (w > 0) h = lerp(h, f.h, w);
  }
  return h;
};

// sol sous (x, z) : terrain ou ponton. gi donne le détail du dernier appel.
export const gi = { isl: null, pier: false };
export const groundAt = (x, z) => {
  gi.isl = null; gi.pier = false;
  for (let i = 0; i < islands.length; i++) {
    const isl = islands[i], dx = x - isl.x, dz = z - isl.z;
    if (dx * dx + dz * dz > isl.r * isl.r * 2.9) continue;
    gi.isl = isl;
    let h = terrainH(isl, x, z);
    const k = isl.dock, al = dx * k.ux + dz * k.uz, ac = dx * k.tx + dz * k.tz, aac = Math.abs(ac);
    const ext = G.ship && G.ship.moored === isl && aac < 1.7 ? 2.8 : 0;
    const onMain = al >= k.s0 - 0.5 && al <= k.s1 + 1.7 && aac <= 1.7;
    const onHead = al >= k.s1 - 1.7 && al <= k.s1 + 1.7 + ext && aac <= 7 && (al <= k.s1 + 1.7 || aac < 1.7);
    if ((onMain || onHead) && PIER_Y > h) { h = PIER_Y; gi.pier = true; }
    return h;
  }
  return -9;
};

export const islandAt = (x, z, margin = 0) => {
  for (let i = 0; i < islands.length; i++) {
    const isl = islands[i];
    if (dist(x, z, isl.x, isl.z) < isl.r * 1.2 + margin) return isl;
  }
  return null;
};

// pousse un cercle hors des obstacles de l'île (arbres, rochers, murs)
export const collideWorld = (p, rad, isl) => {
  if (!isl) return;
  for (let i = 0; i < isl.circles.length; i++) {
    const c = isl.circles[i], dx = p.x - c.x, dz = p.z - c.z, rr = rad + c.r, d2 = dx * dx + dz * dz;
    if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2), k = (rr - d) / d; p.x += dx * k; p.z += dz * k; }
  }
  for (let i = 0; i < isl.segs.length; i++) {
    const s = isl.segs[i], ex = s.bx - s.ax, ez = s.bz - s.az;
    const t = clamp(((p.x - s.ax) * ex + (p.z - s.az) * ez) / (ex * ex + ez * ez), 0, 1);
    const dx = p.x - (s.ax + ex * t), dz = p.z - (s.az + ez * t), rr = rad + s.r, d2 = dx * dx + dz * dz;
    if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2), k = (rr - d) / d; p.x += dx * k; p.z += dz * k; }
  }
};

const W = (isl, al, ac) => ({ x: isl.x + al * isl.dock.ux + ac * isl.dock.tx, z: isl.z + al * isl.dock.uz + ac * isl.dock.tz });

// ---------- préfabriqués ----------
const house = (w, d, h, wall, roof) => {
  const b = builder();
  part(b, prim.box(), wall, [0, h / 2, 0], [0, 0, 0], [w, h, d]);
  part(b, prim.cone(4), roof, [0, h + h * 0.32, 0], [0, Math.PI / 4, 0], [w * 1.6, h * 0.64, d * 1.6]);
  part(b, prim.box(), 0x3b2a1c, [0, 1.0, d / 2 + 0.03], [0, 0, 0], [1.1, 2.0, 0.1]);
  part(b, prim.box(), 0x2b3a44, [w * 0.28, h * 0.62, d / 2 + 0.03], [0, 0, 0], [0.9, 0.9, 0.1]);
  part(b, prim.box(), 0x2b3a44, [-w * 0.28, h * 0.62, d / 2 + 0.03], [0, 0, 0], [0.9, 0.9, 0.1]);
  part(b, prim.box(), 0x6d6258, [w * 0.25, h + h * 0.5, -d * 0.2], [0, 0, 0], [0.7, h * 0.5, 0.7]);
  return bake(b);
};
const stand = (awn) => {
  const b = builder();
  [[-1.5, -1], [1.5, -1], [-1.5, 1], [1.5, 1]].forEach(([x, z]) => part(b, prim.cyl(5), 0x5a4129, [x, 1.3, z], [0, 0, 0], [0.16, 2.6, 0.16]));
  part(b, prim.box(), 0x7a5a38, [0, 0.9, 0.9], [0, 0, 0], [3.4, 0.25, 0.9]);
  part(b, prim.box(), 0x65492d, [0, 0.45, 0.9], [0, 0, 0], [3.2, 0.9, 0.7]);
  for (let i = 0; i < 6; i++) part(b, prim.box(), i % 2 ? 0xefe3c8 : awn, [-1.5 + i * 0.6, 2.75, 0.2], [0.22, 0, 0], [0.6, 0.08, 3.0]);
  part(b, prim.box(), 0x8a6a45, [-0.9, 1.25, 0.9], [0, 0.3, 0], [0.5, 0.45, 0.5]);
  part(b, prim.cyl(7), 0x6b4a2e, [0.8, 1.35, 0.9], [0, 0, 0], [0.5, 0.65, 0.5]);
  return bake(b);
};
const board = () => {
  const b = builder();
  part(b, prim.cyl(5), 0x4d3823, [-1.3, 1.3, 0], [0, 0, 0], [0.18, 2.6, 0.18]);
  part(b, prim.cyl(5), 0x4d3823, [1.3, 1.3, 0], [0, 0, 0], [0.18, 2.6, 0.18]);
  part(b, prim.box(), 0x7a5a38, [0, 1.75, 0], [0, 0, 0], [2.9, 1.7, 0.14]);
  [[-0.85, 2.05, 0.05], [0.1, 2.1, -0.04], [0.9, 1.95, 0.08], [-0.4, 1.4, -0.06], [0.6, 1.35, 0.03]].forEach(([x, y, r]) =>
    part(b, prim.box(), 0xefe3c8, [x, y, 0.09], [0, 0, r], [0.6, 0.75, 0.03]));
  part(b, prim.cone(4), 0x5a4129, [0, 2.85, 0], [0, Math.PI / 4, 0], [3.6, 0.5, 0.9]);
  return bake(b);
};
const tent = (col) => {
  const b = builder();
  part(b, prim.cone(5), col, [0, 1.5, 0], [0, 0.3, 0], [4.2, 3.0, 4.2]);
  part(b, prim.cyl(4), 0x4d3823, [0, 3.1, 0], [0, 0, 0], [0.1, 0.6, 0.1]);
  return bake(b);
};
const campfire = () => {
  const b = builder();
  for (let i = 0; i < 7; i++) { const a = (i / 7) * TAU; part(b, prim.sph(5), 0x77736b, [Math.sin(a) * 0.8, 0.12, Math.cos(a) * 0.8], [0, a, 0], [0.45, 0.3, 0.4]); }
  part(b, prim.cyl(5), 0x3a2a1c, [0, 0.2, 0], [1.2, 0.4, 0], [0.2, 1.3, 0.2]);
  part(b, prim.cyl(5), 0x3a2a1c, [0, 0.2, 0], [1.2, 2.2, 0], [0.2, 1.3, 0.2]);
  return bake(b);
};
const palmGeom = () => {
  const b = builder();
  let x = 0, y = 0;
  for (let i = 0; i < 5; i++) {
    const tilt = 0.06 + i * 0.05;
    part(b, prim.cyl(6, 0.85), i % 2 ? 0x8a6a45 : 0x7a5c3a, [x + Math.sin(tilt) * 0.65, y + 0.65, 0], [0, 0, -tilt], [0.5 - i * 0.05, 1.4, 0.5 - i * 0.05]);
    x += Math.sin(tilt) * 1.3; y += Math.cos(tilt) * 1.3;
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + 0.2, c = i % 2 ? 0x3f8f3f : 0x4fa548;
    part(b, prim.cone(4), c, [x + Math.sin(a) * 1.2, y + 0.15, Math.cos(a) * 1.2], [Math.PI / 2 + 0.25, a, 0, 'YXZ'], [0.9, 2.6, 0.16]);
    part(b, prim.cone(4), c, [x + Math.sin(a) * 2.9, y - 0.55, Math.cos(a) * 2.9], [Math.PI / 2 + 0.8, a, 0, 'YXZ'], [0.7, 1.9, 0.12]);
  }
  part(b, prim.sph(5), 0x4a3320, [x + 0.25, y - 0.1, 0.2], [0, 0, 0], [0.36, 0.36, 0.36]);
  part(b, prim.sph(5), 0x4a3320, [x - 0.2, y - 0.15, -0.2], [0, 0, 0], [0.34, 0.34, 0.34]);
  return bake(b);
};
const chestParts = (tier) => {
  const wood = [0x6b4a2e, 0x5a3a2a, 0x3f2a3a][tier - 1], metal = [0x9a8f7a, 0xc9a23f, 0xe2b84a][tier - 1];
  const b = builder();
  part(b, prim.box(), wood, [0, 0.3, 0], [0, 0, 0], [1.2, 0.6, 0.8]);
  part(b, prim.box(), metal, [-0.45, 0.3, 0], [0, 0, 0], [0.12, 0.64, 0.84]);
  part(b, prim.box(), metal, [0.45, 0.3, 0], [0, 0, 0], [0.12, 0.64, 0.84]);
  const l = builder();
  part(l, prim.box(), wood, [0, 0.14, 0.4], [0, 0, 0], [1.2, 0.28, 0.8]);
  part(l, prim.box(), metal, [0, 0.14, 0.4], [0, 0, 0], [0.16, 0.32, 0.84]);
  part(l, prim.box(), metal, [0, 0.02, 0.82], [0, 0, 0], [0.22, 0.22, 0.06]);
  return [bake(b), bake(l)];
};
const crateGeom = () => {
  const b = builder();
  part(b, prim.box(), 0x8a6a45, [0, 0, 0], [0, 0, 0], [1.3, 1.1, 1.3]);
  part(b, prim.box(), 0x5a4129, [0, 0, 0], [0, 0, 0], [1.36, 0.16, 1.36]);
  part(b, prim.box(), 0x5a4129, [0, 0.45, 0], [0, 0, 0], [1.36, 0.1, 1.36]);
  part(b, prim.box(), 0x5a4129, [0, -0.45, 0], [0, 0, 0], [1.36, 0.1, 1.36]);
  return bake(b);
};
const sackGeom = () => {
  const b = builder();
  part(b, prim.sph(6), 0xb08a4a, [0, 0.28, 0], [0, 0, 0], [0.62, 0.56, 0.56]);
  part(b, prim.cone(5), 0xb08a4a, [0, 0.62, 0], [0, 0, 0], [0.3, 0.3, 0.3]);
  part(b, prim.sph(5), 0xf2c94c, [0.18, 0.5, 0.16], [0, 0, 0], [0.16, 0.16, 0.16]);
  return bake(b);
};

let crateG, sackG;

// ---------- terrain ----------
const terrainMesh = (isl) => {
  const N = G.quality > 1 ? 84 : 64, half = isl.r * 1.42, step = (half * 2) / N;
  const hs = new Float32Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) hs[j * (N + 1) + i] = terrainH(isl, isl.x - half + i * step, isl.z - half + j * step);
  const pos = [], col = [];
  const sand = lin(0xe9d6a0), wet = lin(0xc9b47c), g1 = lin(isl.fort ? 0x7f9160 : 0x6fb04e), g2 = lin(isl.fort ? 0x6f8256 : 0x569642), rock = lin(0x8d877b), stone = lin(0xa39c8e);
  const tri = (ax, az, ah, bx, bz, bh, cx, cz, ch) => {
    const mx = Math.max(ah, bh, ch), mn = Math.min(ah, bh, ch);
    if (mx < -3) return;
    pos.push(ax, ah, az, bx, bh, bz, cx, ch, cz);
    const h = (ah + bh + ch) / 3, slope = (mx - mn) / step, n = fbm(ax * 0.11, az * 0.11);
    let c = h < 0.35 ? wet : h < 1.55 + n * 0.5 ? sand : n > 0.5 ? g1 : g2;
    if (slope > 0.62 && h > 1) c = rock;
    if (isl.fort && h > 4.6 && slope < 0.1) c = stone;
    if (isl.safe && h > 1.5 && slope < 0.06 && Math.hypot(ax - isl.flats[0].x, az - isl.flats[0].z) < isl.flats[0].r * 0.62) c = stone;
    const k = 0.92 + n * 0.16;
    for (let q = 0; q < 3; q++) col.push(c[0] * k, c[1] * k, c[2] * k);
  };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x0 = isl.x - half + i * step, z0 = isl.z - half + j * step, x1 = x0 + step, z1 = z0 + step;
    const a = hs[j * (N + 1) + i], b = hs[j * (N + 1) + i + 1], c = hs[(j + 1) * (N + 1) + i], d = hs[(j + 1) * (N + 1) + i + 1];
    tri(x0, z0, a, x0, z1, c, x1, z0, b);
    tri(x1, z0, b, x0, z1, c, x1, z1, d);
  }
  const m = mesh(raw(builder(), pos, col), MAT.vc, 2);
  G.scene.add(m);
};

const buildFort = (isl, b) => {
  const a = isl.dock.a, H = 26, wallC = 0x9a9488, darkC = 0x7d776c;
  const wall = (al0, ac0, al1, ac1) => {
    const p0 = W(isl, al0, ac0), p1 = W(isl, al1, ac1), len = Math.hypot(al1 - al0, ac1 - ac0);
    const mid = W(isl, (al0 + al1) / 2, (ac0 + ac1) / 2), alongAc = Math.abs(ac1 - ac0) > Math.abs(al1 - al0);
    part(b, prim.box(), wallC, [mid.x, 5.5, mid.z], [0, a, 0], alongAc ? [len, 9, 2.4] : [2.4, 9, len]);
    const n = Math.floor(len / 3);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, q = W(isl, lerp(al0, al1, t), lerp(ac0, ac1, t));
      part(b, prim.box(), darkC, [q.x, 10.5, q.z], [0, a, 0], alongAc ? [1.5, 1, 2.6] : [2.6, 1, 1.5]);
    }
    isl.segs.push({ ax: p0.x, az: p0.z, bx: p1.x, bz: p1.z, r: 1.3 });
  };
  wall(H, -H, H, -4.5); wall(H, 4.5, H, H); wall(-H, -H, -H, H); wall(-H, -H, H, -H); wall(-H, H, H, H);
  const lint = W(isl, H, 0);
  part(b, prim.box(), darkC, [lint.x, 9.4, lint.z], [0, a, 0], [10, 2.2, 2.8]);
  [[H, H], [H, -H], [-H, H], [-H, -H]].forEach(([al, ac]) => {
    const p = W(isl, al, ac);
    part(b, prim.cyl(10), wallC, [p.x, 6.5, p.z], [0, 0, 0], [8, 13, 8]);
    part(b, prim.cyl(10), darkC, [p.x, 13.4, p.z], [0, 0, 0], [9, 1.2, 9]);
    part(b, prim.cone(10), 0x6e2b25, [p.x, 16, p.z], [0, 0, 0], [9.6, 4.5, 9.6]);
    isl.circles.push({ x: p.x, z: p.z, r: 4.3 });
  });
  const kp = W(isl, -18, 0);
  part(b, prim.box(), wallC, [kp.x, 9.5, kp.z], [0, a, 0], [15, 10, 10]);
  part(b, prim.box(), darkC, [kp.x, 15, kp.z], [0, a, 0], [16, 1.2, 11]);
  part(b, prim.cone(4), 0x6e2b25, [kp.x, 18, kp.z], [0, a + Math.PI / 4, 0], [17, 5, 17]);
  const dr = W(isl, -12.9, 0);
  part(b, prim.box(), 0x3b2a1c, [dr.x, 6.4, dr.z], [0, a, 0], [2.4, 3.2, 0.3]);
  part(b, prim.cyl(5), 0x4d3823, [kp.x, 23, kp.z], [0, 0, 0], [0.25, 6, 0.25]);
  part(b, prim.box(), 0xb3312a, [kp.x + 1.3, 25, kp.z], [0, 0, 0], [2.6, 1.6, 0.08]);
  const k0 = W(isl, -18, -7), k1 = W(isl, -18, 7);
  isl.segs.push({ ax: k0.x, az: k0.z, bx: k1.x, bz: k1.z, r: 5.2 });
};

const buildIsland = (spec) => {
  const a = spec.dock;
  const isl = { ...spec, circles: [], segs: [], flats: [], camps: [], chestList: [] };
  isl.dock = { a, ux: Math.sin(a), uz: Math.cos(a), tx: Math.cos(a), tz: -Math.sin(a), y: PIER_Y };
  const Rd = radiusAt(isl, a);
  isl.dock.Rd = Rd;
  spec.flats.forEach((f) => {
    const p = W(isl, f.af * Rd, f.ac);
    isl.flats.push({ x: p.x, z: p.z, r: f.r, h: f.h !== undefined ? f.h : terrainH(isl, p.x, p.z) + 0.2 });
  });
  // ponton : part de la terre (hauteur du ponton) et avance de 20 m en mer, tête en T
  let s0 = Rd;
  while (s0 > Rd * 0.3) { const p = W(isl, s0, 0); if (terrainH(isl, p.x, p.z) >= PIER_Y) break; s0 -= 0.5; }
  isl.dock.s0 = s0; isl.dock.s1 = Rd + 20;
  const k = isl.dock, b = builder();
  const pc = W(isl, (k.s0 + k.s1) / 2, 0), len = k.s1 - k.s0 + 2;
  part(b, prim.box(), 0x8a6a45, [pc.x, PIER_Y - 0.15, pc.z], [0, a, 0], [3.4, 0.3, len]);
  const hc = W(isl, k.s1, 0);
  part(b, prim.box(), 0x80613f, [hc.x, PIER_Y - 0.14, hc.z], [0, a, 0], [14, 0.3, 3.4]);
  for (let s = k.s0 + 2; s < k.s1; s += 4) [-1.6, 1.6].forEach((ac) => { const p = W(isl, s, ac); part(b, prim.cyl(6), 0x4d3823, [p.x, -0.6, p.z], [0, 0, 0], [0.4, 5, 0.4]); });
  for (let ac = -6.6; ac <= 6.7; ac += 3.3) [-1.6, 1.6].forEach((o) => { const p = W(isl, k.s1 + o, ac); part(b, prim.cyl(6), 0x4d3823, [p.x, -0.3, p.z], [0, 0, 0], [0.42, 5.6, 0.42]); });
  for (let s = Rd + 3; s <= k.s1 - 2; s += 3.6) { const p = W(isl, s, 0); shipCircles.push({ x: p.x, z: p.z, r: 2 }); }
  for (let ac = -6; ac <= 6; ac += 3) { const p = W(isl, k.s1, ac); shipCircles.push({ x: p.x, z: p.z, r: 2 }); }
  const lp = W(isl, k.s1 - 1.2, 6.2);
  part(b, prim.cyl(5), 0x3a2a1c, [lp.x, PIER_Y + 1.5, lp.z], [0, 0, 0], [0.14, 3, 0.14]);
  isl.lamp = { x: lp.x, y: PIER_Y + 3.1, z: lp.z };

  const R = rng(Math.floor(spec.seed * 1000));
  const freeSpot = (x, z, pad) => {
    const dx = x - isl.x, dz = z - isl.z, al = dx * k.ux + dz * k.uz, ac = dx * k.tx + dz * k.tz;
    if (al > 0 && Math.abs(ac) < 5.5) return false;
    if (isl.fort && Math.abs(al) < 32 && Math.abs(ac) < 32) return false;
    for (const f of isl.flats) if (Math.hypot(x - f.x, z - f.z) < f.r * 0.8 + pad) return false;
    return true;
  };

  // camps ennemis
  spec.camps.forEach((c) => {
    const p = W(isl, c.af * Rd, c.ac);
    isl.camps.push({ id: c.id, x: p.x, z: p.z, foes: c.foes, weak: !!c.weak });
    if (isl.fort) return;
    const y = terrainH(isl, p.x, p.z);
    part(b, campfire(), null, [p.x, y, p.z]);
    fires.push({ x: p.x, y: y + 0.4, z: p.z, isl });
    isl.circles.push({ x: p.x, z: p.z, r: 0.9 });
    for (let i = 0; i < 3; i++) {
      const an = R() * TAU, rr = 9 + R() * 4, tx = p.x + Math.sin(an) * rr, tz = p.z + Math.cos(an) * rr, ty = terrainH(isl, tx, tz);
      part(b, tent([0xd9cdb0, 0xb9a98a, 0x9c5b4a][i % 3]), null, [tx, ty - 0.1, tz], [0, R() * 3, 0]);
      isl.circles.push({ x: tx, z: tz, r: 1.9 });
      const cx = tx + 2.6, cz = tz + 1.2;
      part(b, crateG, null, [cx, terrainH(isl, cx, cz) + 0.5, cz], [0, R() * 3, 0], [0.8, 0.8, 0.8]);
      isl.circles.push({ x: cx, z: cz, r: 0.75 });
    }
  });

  // port : place, étals, maisons, phare
  if (isl.safe) {
    const st = [
      { tab: 'marchand', al: 0.6 * Rd + 6, ac: -11, col: 0xb3312a, label: 'Marchand', rot: a + Math.PI / 2 },
      { tab: 'chantier', al: 0.6 * Rd + 6, ac: 11, col: 0x1f4a66, label: 'Chantier naval', rot: a - Math.PI / 2 },
    ];
    st.forEach((s) => {
      const p = W(isl, s.al, s.ac), y = terrainH(isl, p.x, p.z);
      part(b, stand(s.col), null, [p.x, y, p.z], [0, s.rot, 0]);
      isl.circles.push({ x: p.x, z: p.z, r: 1.9 });
      interactables.push({ kind: 'port', tab: s.tab, x: p.x, y, z: p.z, r: 4.2, label: s.label });
    });
    const bp = W(isl, 0.6 * Rd - 7, 0), by = terrainH(isl, bp.x, bp.z);
    part(b, board(), null, [bp.x, by, bp.z], [0, a, 0]);
    isl.circles.push({ x: bp.x, z: bp.z, r: 1.3 });
    interactables.push({ kind: 'port', tab: 'primes', x: bp.x, y: by, z: bp.z, r: 4, label: 'Tableau des primes' });
    const cols = [[0xe8d9b5, 0xa8452f], [0xd9b98a, 0x7a3b2a], [0xc9d6c0, 0x5d6b7a], [0xefe3c8, 0x8e2a22], [0xd8c7a0, 0x4f5d4a]];
    [[44, -27, 0.4], [30, -14, 1.2], [26, 12, -0.9], [42, 28, 2.6], [60, -31, 0.2], [61, 31, 3.0], [12, -30, 0.9], [8, 26, 2.1], [-8, -6, 0.5]].forEach(([al, ac, r], i) => {
      const p = W(isl, al, ac), y = terrainH(isl, p.x, p.z) - 0.3, c = cols[i % cols.length], w = 6 + (i % 3), d = 5.5 + ((i * 7) % 3), h = 3.6 + (i % 2) * 1.6;
      part(b, house(w, d, h, c[0], c[1]), null, [p.x, y, p.z], [0, a + r, 0]);
      isl.circles.push({ x: p.x, z: p.z, r: Math.max(w, d) * 0.62 });
    });
    const lh = W(isl, -0.5 * Rd, 24), ly = terrainH(isl, lh.x, lh.z);
    for (let i = 0; i < 5; i++) part(b, prim.cyl(10, 0.9), i % 2 ? 0xb3312a : 0xf3ede0, [lh.x, ly + 2 + i * 4, lh.z], [0, 0, 0], [5.2 - i * 0.5, 4, 5.2 - i * 0.5]);
    part(b, prim.cyl(8), 0x2b3a44, [lh.x, ly + 21, lh.z], [0, 0, 0], [3.6, 2.2, 3.6]);
    part(b, prim.cone(8), 0xb3312a, [lh.x, ly + 23.3, lh.z], [0, 0, 0], [4.4, 2.4, 4.4]);
    isl.circles.push({ x: lh.x, z: lh.z, r: 3 });
    isl.beacon = { x: lh.x, y: ly + 21, z: lh.z };
    for (let i = 0; i < 7; i++) {
      const p = W(isl, 0.6 * Rd + 12 + R() * 6, (R() - 0.5) * 30), y = terrainH(isl, p.x, p.z);
      if (Math.abs((p.x - isl.x) * k.tx + (p.z - isl.z) * k.tz) < 4) continue;
      part(b, crateG, null, [p.x, y + 0.5, p.z], [0, R() * 3, 0], [0.9, 0.9, 0.9]);
      isl.circles.push({ x: p.x, z: p.z, r: 0.85 });
    }
  }
  if (isl.fort) buildFort(isl, b);

  // coffres
  spec.chests.forEach((c) => {
    const p = W(isl, c.af * Rd, c.ac), y = terrainH(isl, p.x, p.z), [bg, lg] = chestParts(c.tier);
    const grp = new THREE.Group(), base = new THREE.Mesh(bg, MAT.vc), lid = new THREE.Mesh(lg, MAT.vc);
    base.castShadow = lid.castShadow = true;
    lid.position.set(0, 0.6, -0.4);
    grp.add(base, lid); grp.position.set(p.x, y, p.z); grp.rotation.y = R() * TAU;
    G.scene.add(grp);
    const ch = { kind: 'chest', x: p.x, y, z: p.z, r: 2.4, tier: c.tier, open: false, lid, isl, label: 'Coffre', hold: 0.7 };
    chests.push(ch); isl.chestList.push(ch);
    isl.circles.push({ x: p.x, z: p.z, r: 0.8 });
  });

  // palmiers et rochers
  isl.palms = []; isl.rocksM = [];
  let tries = 0;
  while (isl.palms.length < spec.palms && tries++ < 900) {
    const an = R() * TAU, rr = isl.r * (0.1 + R() * 0.82), x = isl.x + Math.sin(an) * rr, z = isl.z + Math.cos(an) * rr, h = terrainH(isl, x, z);
    if (h < 1.2 || !freeSpot(x, z, 2)) continue;
    const s = 0.8 + R() * 0.6;
    isl.palms.push({ x, y: h - 0.2, z, s, r: R() * TAU });
    isl.circles.push({ x, z, r: 0.42 * s });
  }
  tries = 0;
  while (isl.rocksM.length < spec.rocks && tries++ < 600) {
    const an = R() * TAU, rr = isl.r * (0.3 + R() * 0.85), x = isl.x + Math.sin(an) * rr, z = isl.z + Math.cos(an) * rr, h = terrainH(isl, x, z);
    if (h < -1.2 || !freeSpot(x, z, 3)) continue;
    const s = 0.8 + R() * 2.2;
    isl.rocksM.push({ x, y: h + s * 0.15, z, s, r: R() * TAU, sy: 0.6 + R() * 0.5 });
    if (h > -0.3) isl.circles.push({ x, z, r: s * 0.52 });
  }
  const pm = mesh(b, MAT.vc, 3);
  G.scene.add(pm);
  terrainMesh(isl);
  islands.push(isl);
  return isl;
};

const spawnCrate = (x, z, table, wreck = -1) => {
  const m = new THREE.Mesh(crateG, MAT.vc);
  m.castShadow = true;
  G.scene.add(m);
  seaPickups.push({ x, z, mesh: m, table, wreck, ph: Math.random() * 6, t: 0 });
};
export const dropCrates = (x, z, table, n) => {
  for (let i = 0; i < n; i++) { const a = Math.random() * TAU, r = 3 + Math.random() * 7; spawnCrate(x + Math.sin(a) * r, z + Math.cos(a) * r, table); }
};
export const rollLoot = (table, n) => {
  const t = DROPS[table], tot = t.reduce((s, e) => s + e[1], 0), out = [];
  for (let i = 0; i < n; i++) { let r = Math.random() * tot; for (const e of t) { r -= e[1]; if (r <= 0) { out.push(e[0]); break; } } }
  return out;
};
export const dropLoot = (x, y, z, loot, ammo = 0, bag = false) => {
  const m = new THREE.Mesh(sackG, MAT.vc);
  m.castShadow = true; m.position.set(x, y, z); if (bag) m.scale.setScalar(1.6);
  G.scene.add(m);
  groundPickups.push({ x, y, z, mesh: m, loot, ammo, bag, t: 0 });
};

// remet coffres et épaves en état pour une nouvelle sortie
export const resetSortieWorld = () => {
  chests.forEach((c) => { c.open = false; c.lid.rotation.x = 0; });
  for (let i = seaPickups.length - 1; i >= 0; i--) { G.scene.remove(seaPickups[i].mesh); seaPickups.splice(i, 1); }
  for (let i = groundPickups.length - 1; i >= 0; i--) { G.scene.remove(groundPickups[i].mesh); groundPickups.splice(i, 1); }
  wrecks.forEach((w, i) => {
    w.looted = false;
    for (let j = 0; j < 3; j++) { const a = (j / 3) * TAU + i, r = 11 + j * 2; spawnCrate(w.x + Math.sin(a) * r, w.z + Math.cos(a) * r, 'wreck', i); }
  });
};

export const initWorld = () => {
  crateG = crateGeom(); sackG = sackGeom();
  ISLANDS.forEach(buildIsland);
  // instances : palmiers et rochers de toutes les îles en deux appels de dessin
  const palms = islands.flatMap((i) => i.palms), rocks = islands.flatMap((i) => i.rocksM);
  const d = new THREE.Object3D();
  const pim = new THREE.InstancedMesh(palmGeom(), MAT.vc, palms.length);
  palms.forEach((p, i) => { d.position.set(p.x, p.y, p.z); d.rotation.set(0, p.r, 0); d.scale.setScalar(p.s); d.updateMatrix(); pim.setMatrixAt(i, d.matrix); });
  pim.castShadow = true; G.scene.add(pim);
  const rb = builder(); part(rb, prim.sph(6), 0x8d877b);
  const rim = new THREE.InstancedMesh(bake(rb), MAT.vc, rocks.length);
  rocks.forEach((p, i) => { d.position.set(p.x, p.y, p.z); d.rotation.set(p.r * 0.3, p.r, 0); d.scale.set(p.s, p.s * p.sy, p.s * 0.9); d.updateMatrix(); rim.setMatrixAt(i, d.matrix); });
  rim.castShadow = true; rim.receiveShadow = true; G.scene.add(rim);
  // épaves
  WRECKS.forEach((w, i) => {
    const b = builder(), r = i * 1.3;
    part(b, prim.box(), 0x4d3823, [0, 0.2, 0], [0.25, r, 0.5], [3.4, 2.2, 9]);
    part(b, prim.cyl(6), 0x5a4129, [1, 3.4, 1.5], [0.5, r, -0.45], [0.5, 9, 0.5]);
    part(b, prim.box(), 0xcfc3a5, [1.9, 4.6, 2.4], [0.5, r, -0.45], [3.2, 2.4, 0.08]);
    for (let j = 0; j < 4; j++) part(b, prim.box(), 0x4d3823, [-1.5 + j * 0.9, 1.2, -3 + j * 1.6], [0.2 * j, r, 0.9], [0.3, 2.6, 0.5]);
    const m = mesh(b, MAT.vc, 1);
    m.position.set(w.x, 0, w.z);
    G.scene.add(m);
    wrecks.push({ x: w.x, z: w.z, mesh: m, looted: false });
    shipCircles.push({ x: w.x, z: w.z, r: 4.5 });
  });
  resetSortieWorld();
};

export const updateWorld = (dt) => {
  const t = G.time, ship = G.ship, pl = G.player;
  wrecks.forEach((w) => { w.mesh.position.y = waveH(w.x, w.z, t) * 0.5 - 0.3; w.mesh.rotation.z = Math.sin(t * 0.7 + w.x) * 0.05; });
  for (let i = seaPickups.length - 1; i >= 0; i--) {
    const p = seaPickups[i];
    p.t += dt;
    p.mesh.position.set(p.x, waveH(p.x, p.z, t) + 0.1, p.z);
    p.mesh.rotation.set(Math.sin(t + p.ph) * 0.2, p.ph + t * 0.2, Math.cos(t * 0.8 + p.ph) * 0.2);
    if (ship && ship.alive && pl.aboard && dist(p.x, p.z, ship.x, ship.z) < 9.5) {
      emit('seaLoot', p);
      if (p.taken) { G.scene.remove(p.mesh); seaPickups.splice(i, 1); }
    } else if (p.wreck < 0 && p.t > 150) { G.scene.remove(p.mesh); seaPickups.splice(i, 1); }
  }
  for (let i = groundPickups.length - 1; i >= 0; i--) {
    const p = groundPickups[i];
    p.t += dt;
    p.mesh.rotation.y += dt * 1.5;
    p.mesh.position.y = p.y + 0.15 + Math.sin(p.t * 3) * 0.08;
    if (pl.mode === 'world' && !pl.dead && p.t > 0.5 && Math.hypot(p.x - pl.x, p.z - pl.z) < 1.9 && Math.abs(p.y - pl.y) < 2.5) {
      emit('groundLoot', p);
      if (p.taken) { G.scene.remove(p.mesh); groundPickups.splice(i, 1); }
    }
  }
};

export const inSafe = (x, z) => dist(x, z, islands[0].x, islands[0].z) < WORLD.safeR;
