import { THREE } from './three.js';
import { lerp, smooth, rng, TAU } from './util.js';
import { prim, builder, part, raw, bake, mesh, MAT, lin } from './geo.js';

// Repère du navire : avant = +z, bâbord = +x, tribord = -x, flottaison à y = 0.
export const hullF = (u) => (u < 0.35 ? lerp(0.72, 1, smooth(0, 0.35, u)) : u < 0.6 ? 1 : Math.pow(Math.max(0, 1 - Math.pow((u - 0.6) / 0.4, 2)), 0.6));
const sheer = (u) => 0.75 * Math.pow(Math.max(0, (u - 0.55) / 0.45), 2) + 0.25 * Math.pow(Math.max(0, (0.3 - u) / 0.3), 2);

const texCache = {};
const sailTex = (kind, torn) => {
  const key = kind + torn;
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'), R = rng(kind.length * 31 + torn * 7);
  g.fillStyle = kind === 'cream' ? '#efe3c8' : kind === 'red' ? '#e9dcc0' : '#24222a';
  g.fillRect(0, 0, 128, 128);
  if (kind === 'red') { g.fillStyle = '#a8322a'; for (let i = 0; i < 4; i++) g.fillRect(i * 32, 0, 16, 128); }
  g.strokeStyle = kind === 'black' ? 'rgba(200,160,60,.5)' : 'rgba(90,70,40,.28)';
  g.lineWidth = 1.5;
  for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(i * 21.3, 0); g.lineTo(i * 21.3, 128); g.stroke(); }
  if (kind === 'black') { g.fillStyle = '#c9a23f'; g.fillRect(58, 30, 12, 68); g.fillRect(36, 52, 56, 12); }
  if (torn) {
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < torn * 7; i++) {
      g.beginPath();
      const x = R() * 128, y = 20 + R() * 108, r = 5 + R() * (torn > 1 ? 16 : 9);
      for (let j = 0; j < 7; j++) { const a = (j / 7) * TAU, rr = r * (0.6 + R() * 0.6); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
      g.fill();
    }
    if (torn > 1) for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(i * 15, 128); g.lineTo(i * 15 + 8, 128 - 20 - R() * 40); g.lineTo(i * 15 + 16, 128); g.fill(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (texCache[key] = t);
};
export const sailMats = (kind) => [0, 1, 2].map((torn) => new THREE.MeshLambertMaterial({ map: sailTex(kind, torn), side: THREE.DoubleSide, alphaTest: 0.5 }));

export const buildShipModel = (sp) => {
  const { L, B, deckY, draft, qh } = sp;
  const hb = (lz) => (B / 2) * hullF(lz / L + 0.5);
  const qhF = (u) => qh * smooth(0.3, 0.24, u);
  const deckAt = (lz) => deckY + qhF(lz / L + 0.5);
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  const R = rng(L * 97 + B * 13);
  const cBottom = lin(0x2f2219), cWood = lin(sp.hullCol), cTrim = lin(sp.trim), cRail = lin(0x3a2a1c);

  const section = (u, sgn) => {
    const b = (B / 2) * hullF(u), rise = smooth(0.78, 1, u) * draft * 0.92, sh = sheer(u) + qhF(u), z = (u - 0.5) * L + smooth(0.8, 1, u) * 1.2;
    return [[0, -draft + rise, z], [sgn * b * 0.55, -draft * 0.78 + rise * 0.9, z], [sgn * b * 0.93, -0.35 + rise * 0.3, z], [sgn * b, deckY * 0.55 + sh * 0.5, z], [sgn * b, deckY + 0.95 + sh, z]];
  };
  const rowCol = [cBottom, cBottom, cWood, cTrim];
  const loft = (ua, ub, sides, transom) => {
    const pos = [], col = [], n = Math.max(2, Math.ceil((ub - ua) * 26));
    sides.forEach((sgn) => {
      for (let i = 0; i < n; i++) {
        const a = section(lerp(ua, ub, i / n), sgn), b = section(lerp(ua, ub, (i + 1) / n), sgn);
        for (let j = 0; j < 4; j++) {
          const q = [a[j], b[j], a[j + 1], b[j], b[j + 1], a[j + 1]];
          q.forEach((p) => { pos.push(p[0], p[1], p[2]); col.push(rowCol[j][0], rowCol[j][1], rowCol[j][2]); });
        }
      }
    });
    if (transom) {
      const l = section(0, 1), r = section(0, -1);
      for (let j = 0; j < 4; j++) {
        [l[j], l[j + 1], r[j], r[j], l[j + 1], r[j + 1]].forEach((p) => { pos.push(p[0], p[1], p[2]); const c = j === 3 ? cTrim : cWood; col.push(c[0] * 0.85, c[1] * 0.85, c[2] * 0.85); });
      }
    }
    return raw(builder(), pos, col);
  };
  const zoneDefs = { stern: [0, 0.24, [1, -1], true], bow: [0.74, 1, [1, -1], false], port: [0.24, 0.74, [1], false], star: [0.24, 0.74, [-1], false] };
  const zoneMesh = {}, dmg = {};
  Object.keys(zoneDefs).forEach((zk) => {
    const [ua, ub, sides, tr] = zoneDefs[zk];
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const m = mesh(loft(ua, ub, sides, tr), mat, 1);
    zoneMesh[zk] = m; group.add(m);
    // traces d'impact (état abîmé) et brèches (état détruit), affichées par échange de modèle
    const mk = (count, big) => {
      const b = builder();
      for (let i = 0; i < count; i++) {
        const u = lerp(ua + 0.02, Math.min(ub, 0.93), R()), sgn = sides[Math.floor(R() * sides.length)], y = lerp(0.2, deckY + 0.6, R());
        const e = 0.01, ang = Math.atan2((hullF(u + e) - hullF(u - e)) * B * 0.5, 2 * e * L);
        const x = sgn * ((B / 2) * hullF(u) + 0.05), z = (u - 0.5) * L, w = big ? 1.4 + R() * 1.2 : 0.7 + R() * 0.8;
        part(b, prim.plane(), big ? 0x0b0908 : 0x1d1712, [x, y, z], [0, sgn * (Math.PI / 2 + ang), R() * 3], [w, w * (0.5 + R() * 0.4), 1]);
        if (big) part(b, prim.box(), 0x2f2219, [x + sgn * 0.3, y + 0.3, z + 0.4], [R(), R() * 3, R()], [0.18, 1.6, 0.35]);
      }
      const m2 = mesh(b, MAT.vc2, 0);
      m2.visible = false; group.add(m2);
      return m2;
    };
    dmg[zk] = [mk(6, false), mk(4, true)];
  });

  // pont, gaillard arrière, marches
  const db = builder();
  {
    const pos = [], col = [], n = 28, c1 = lin(sp.deckCol), c2 = lin(sp.deckCol).map((v) => v * 0.86);
    for (let i = 0; i < n; i++) {
      const u0 = lerp(0.005, 0.975, i / n), u1 = lerp(0.005, 0.975, (i + 1) / n);
      const z0 = (u0 - 0.5) * L, z1 = (u1 - 0.5) * L, b0 = hb(z0) - 0.05, b1 = hb(z1) - 0.05, y0 = deckAt(z0), y1 = deckAt(z1), c = i % 2 ? c1 : c2;
      [[b0, y0, z0], [b1, y1, z1], [-b0, y0, z0], [-b0, y0, z0], [b1, y1, z1], [-b1, y1, z1]].forEach((p) => { pos.push(p[0], p[1], p[2]); col.push(c[0], c[1], c[2]); });
    }
    raw(db, pos, col);
  }
  const deck = mesh(db, MAT.vc2, 2);
  group.add(deck);

  const sb = builder(); // superstructure fixe
  // lisse (main courante) sur le pavois
  for (let i = 0; i < 20; i++) {
    const u = lerp(0.01, 0.95, (i + 0.5) / 20), z = (u - 0.5) * L, len = (0.94 * L) / 20 + 0.1;
    const e = 0.01, ang = Math.atan2((hullF(u + e) - hullF(u - e)) * B * 0.5, 2 * e * L);
    [1, -1].forEach((s) => part(sb, prim.box(), 0x3a2a1c, [s * (hb(z) - 0.02), deckY + 0.98 + sheer(u) + qhF(u), z], [0, s * ang, 0], [0.22, 0.12, len]));
  }
  // beaupré
  part(sb, prim.cyl(6, 0.6), 0x5a4129, [0, deckY + 1.5, L / 2 + 1.6], [Math.PI / 2 - 0.2, 0, 0], [0.4, 6.5, 0.4]);
  // lanterne de poupe, caisses
  part(sb, prim.cyl(5), 0x3a2a1c, [0, deckAt(-L / 2) + 1.6, -L / 2 + 0.3], [0, 0, 0], [0.12, 1.4, 0.12]);
  part(sb, prim.box(), 0xf2c94c, [0, deckAt(-L / 2) + 2.4, -L / 2 + 0.3], [0, 0, 0], [0.4, 0.5, 0.4]);
  part(sb, prim.box(), 0x8a6a45, [B * 0.2, deckY + 0.4, L * 0.22], [0, 0.4, 0], [0.9, 0.8, 0.9]);
  part(sb, prim.cyl(7), 0x6b4a2e, [-B * 0.22, deckY + 0.5, L * 0.2], [0, 0, 0], [0.8, 1, 0.8]);
  // écoutille
  part(sb, prim.box(), 0x4d3823, [0, deckY + 0.08, L * 0.08], [0, 0, 0], [1.8, 0.16, 2.2]);
  // barre : socle
  const helmZ = (0.165 - 0.5) * L, helmY = deckAt(helmZ);
  part(sb, prim.box(), 0x4d3823, [0, helmY + 0.5, helmZ], [0, 0, 0], [0.4, 1, 0.5]);

  // mâts : partie basse fixe, partie haute dans un groupe qui bascule quand la zone est détruite
  const top = new THREE.Group();
  const tb = builder(), sails = [], sMats = sailMats(sp.sail), mastInfo = [];
  sp.masts.forEach((m, mi) => {
    const z = (m.u - 0.5) * L, y0 = deckAt(z), h = m.h;
    part(sb, prim.cyl(7, 0.75), 0x5a4129, [0, y0 + h * 0.31, z], [0, 0, 0], [0.62, h * 0.62, 0.62]);
    part(tb, prim.cyl(7, 0.6), 0x5a4129, [0, y0 + h * 0.8, z], [0, 0, 0], [0.42, h * 0.42, 0.42]);
    part(tb, prim.cyl(8), 0x4d3823, [0, y0 + h * 0.63, z], [0, 0, 0], [1.5, 0.3, 1.5]);
    const w1 = B * 1.32, w2 = B * 0.98, yd1 = y0 + h * 0.6, yd2 = y0 + h * 0.92, h1 = h * 0.6 - 2.7, h2 = h * 0.28;
    part(sb, prim.cyl(6), 0x4d3823, [0, yd1, z + 0.35], [0, 0, Math.PI / 2], [0.26, w1 + 0.8, 0.26]);
    part(tb, prim.cyl(6), 0x4d3823, [0, yd2, z + 0.3], [0, 0, Math.PI / 2], [0.2, w2 + 0.6, 0.2]);
    const mkSail = (w, hh, y, parent, zz) => {
      const g = new THREE.PlaneGeometry(w, hh, 6, 4);
      g.translate(0, -hh / 2, 0);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i) / w, yy = -p.getY(i) / hh; p.setZ(i, Math.cos(x * Math.PI) * Math.sin(yy * Math.PI * 0.9) * w * 0.16); }
      g.computeVertexNormals();
      const s = new THREE.Mesh(g, sMats[0]);
      s.position.set(0, y, zz); s.castShadow = true;
      parent.add(s); sails.push(s);
    };
    mkSail(w1, h1, yd1 - 0.15, group, z + 0.45);
    mkSail(w2, h2, yd2 - 0.1, top, z + 0.4);
    mastInfo.push({ z, top: y0 + h });
    if (mi === sp.masts.length - 1) {
      // foc : triangle entre le mât avant et le beaupré
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, y0 + h * 0.78, z + 0.5, 0, deckY + 2.3, z + 1.4, 0, deckY + 1.9, L / 2 + 3.6], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0.1, 0.95, 0.1, 0.1, 0.9, 0.1], 2));
      g.computeVertexNormals();
      const jib = new THREE.Mesh(g, sMats[0]);
      jib.castShadow = true; jib.userData.jib = true;
      group.add(jib); sails.push(jib);
    }
    part(tb, prim.box(), sp.sail === 'cream' ? 0x16181c : 0xb3312a, [0.9, y0 + h + 0.2, z], [0, 0, 0], [1.8, 1.1, 0.06]);
  });
  const topMesh = mesh(tb, MAT.vc, 1);
  top.add(topMesh);
  group.add(top);
  const sup = mesh(sb, MAT.vc, 3);
  group.add(sup);

  // canons : un maillage par bord (recul animé)
  const cannons = { 1: [], '-1': [] }, cannonMesh = {};
  [1, -1].forEach((s) => {
    const b = builder();
    for (let i = 0; i < sp.cannons; i++) {
      const u = lerp(0.36, 0.68, sp.cannons > 1 ? i / (sp.cannons - 1) : 0.5), z = (u - 0.5) * L, x = s * (hb(z) - 0.5), y = deckAt(z) + 0.5;
      part(b, prim.cyl(7, 0.8), 0x23262b, [x + s * 0.25, y + 0.08, z], [0, 0, -s * Math.PI / 2], [0.46, 1.9, 0.46]);
      part(b, prim.box(), 0x4d3823, [x - s * 0.2, y - 0.22, z], [0, 0, 0], [1.2, 0.36, 0.8]);
      cannons[s].push({ x: x + s * 1.2, y: y + 0.08, z });
    }
    cannonMesh[s] = mesh(b, MAT.vc, 1);
    group.add(cannonMesh[s]);
  });

  // roue de barre (tourne avec le gouvernail)
  const wb = builder();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    part(wb, prim.box(), 0x6b4a2e, [Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0], [0, 0, a], [0.12, 0.46, 0.1]);
    part(wb, prim.box(), 0x8a6a45, [Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0], [0, 0, a + Math.PI / 2], [0.07, 0.95, 0.07]);
  }
  part(wb, prim.cyl(6), 0xc9a23f, [0, 0, 0], [Math.PI / 2, 0, 0], [0.22, 0.2, 0.22]);
  const wheel = mesh(wb, MAT.vc, 1);
  wheel.position.set(0, helmY + 1.15, helmZ + 0.32);
  group.add(wheel);

  const mz = (sp.masts[0].u - 0.5) * L;
  return {
    group, zoneMesh, dmg, sails, sMats, top, wheel, cannons, cannonMesh, mastInfo, hb, deckAt,
    helm: { x: 0, z: helmZ - 0.55 },
    repair: {
      bow: { x: 0, z: 0.34 * L }, port: { x: hb(-0.1 * L) - 1.1, z: -0.1 * L }, star: { x: -(hb(-0.1 * L) - 1.1), z: -0.1 * L },
      stern: { x: 0, z: -0.5 * L + 1.4 }, mast: { x: 1.0, z: mz - 0.2 },
    },
    walkMinZ: (0.035 - 0.5) * L, walkMaxZ: (0.9 - 0.5) * L,
  };
};
