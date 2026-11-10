import { THREE } from './three.js';
import { G, emit } from './state.js';
import { clamp, damp, dampAngle, wrap, dist, smooth, lerp, toWorldX, toWorldZ, toLocalX, toLocalZ } from './util.js';
import { SHIPS, ZONES, FLEET, UPGRADES, WORLD, SAIL_LABEL } from './config.js';
import { buildShipModel } from './shipmodel.js';
import { waveH } from './ocean.js';
import { islands, terrainH, shipCircles, groundAt, dropCrates, inSafe } from './world.js';
import { puff, shake, getBall, freeBall, num } from './fx.js';
import { sfx, sfxAt } from './audio.js';

const BALL_V = 72, BALL_G = 16;
export const balls = [];
const pending = []; // tirs de bordée échelonnés
const SAILF = [0, 0.42, 0.72, 1];
let arcs = null;

export const createShip = (kind, x, z, th) => {
  const sp = SHIPS[kind], model = buildShipModel(sp);
  const s = {
    kind, sp, model, group: model.group, x, z, th, vx: 0, vz: 0, om: 0, rudder: 0, ctrlRudder: 0, sail: 0, sailVis: 0,
    heave: 0, pitch: 0, roll: 0, kick: 0, hullMax: sp.hull, hull: sp.hull, zones: {},
    reload: { 1: 0, '-1': 0 }, recoil: { 1: 0, '-1': 0 }, helm: false, moored: null, moorPose: null, alive: true, sink: 0,
    maxSpeed: sp.speed, dmgMul: 1, reloadMul: 1, ai: null, ramCd: 0, groundCd: 0, fxT: 0, shot: 'hull', speed: 0,
  };
  ZONES.forEach((zk) => { s.zones[zk] = { hp: sp.zone, max: sp.zone, dead: false, state: 0 }; });
  model.group.position.set(x, 0, z);
  G.scene.add(model.group);
  G.ships.push(s);
  return s;
};

export const applyUpgrades = (s, up) => {
  const hm = UPGRADES.hull.mult[up.hull], oldMax = s.hullMax;
  s.hullMax = s.sp.hull * hm; s.hull = Math.min(s.hullMax, s.hull + (s.hullMax - oldMax));
  ZONES.forEach((zk) => { const z = s.zones[zk], om = z.max; z.max = s.sp.zone * hm; z.hp = Math.min(z.max, z.hp + (z.max - om)); });
  s.maxSpeed = s.sp.speed * UPGRADES.sails.mult[up.sails];
  s.dmgMul = UPGRADES.cannons.mult[up.cannons];
  s.reloadMul = 1 + (UPGRADES.cannons.mult[up.cannons] - 1) * 0.7;
};

const disposeShip = (s) => {
  G.scene.remove(s.group);
  s.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  Object.values(s.model.zoneMesh).forEach((m) => m.material.dispose());
  s.model.sMats.forEach((m) => m.dispose());
};

// état visuel d'une zone : intacte, abîmée, détruite (échange de modèle)
export const refreshZone = (s, zk) => {
  const z = s.zones[zk];
  z.state = z.dead ? 2 : z.hp < z.max * 0.6 ? 1 : 0;
  if (zk === 'mast') {
    s.model.sails.forEach((m) => { m.material = s.model.sMats[z.state]; });
    s.model.top.visible = z.state < 2;
  } else {
    s.model.zoneMesh[zk].material.color.setScalar([1, 0.72, 0.42][z.state]);
    s.model.dmg[zk][0].visible = z.state >= 1;
    s.model.dmg[zk][1].visible = z.state >= 2;
  }
};
export const refreshShip = (s) => ZONES.forEach((zk) => refreshZone(s, zk));

const sinkShip = (s, byPlayer) => {
  if (!s.alive) return;
  s.alive = false; s.sink = 0.001; s.helm = false;
  sfxAt('sink', s.x, s.z, 500);
  if (s.kind !== 'player') dropCrates(s.x, s.z, s.kind, s.kind === 'galion' ? 5 : 3);
  emit('sunk', { ship: s, byPlayer });
};

// Point d'entrée unique des dégâts de navire.
export const damageShip = (s, zk, dmg, o = {}) => {
  if (!s.alive || dmg <= 0) return;
  const z = s.zones[zk], absorbed = Math.min(z.hp, dmg), over = dmg - absorbed;
  z.hp -= absorbed;
  const share = zk === 'mast' ? 0 : zk === 'port' || zk === 'star' ? 0.5 : 0.3;
  s.hull -= absorbed * share + over * (zk === 'mast' ? 0.15 : 1);
  if (z.hp <= 0 && !z.dead) { z.dead = true; emit('zoneDown', { ship: s, zone: zk }); }
  refreshZone(s, zk);
  if (s.hull <= 0) sinkShip(s, !!o.byPlayer);
};
export const repairZone = (s, zk, amount) => {
  const z = s.zones[zk];
  z.hp = Math.min(z.max, z.hp + amount);
  if (z.dead && z.hp >= z.max * 0.3) z.dead = false;
  refreshZone(s, zk);
};
export const fullRepair = (s) => { s.hull = s.hullMax; ZONES.forEach((zk) => { s.zones[zk].hp = s.zones[zk].max; s.zones[zk].dead = false; }); refreshShip(s); };

export const zoneAt = (s, lx, ly, lz) => {
  const u = lz / s.sp.L + 0.5;
  if (ly > s.sp.deckY + 1.7) return 'mast';
  return u < 0.24 ? 'stern' : u > 0.74 ? 'bow' : lx > 0 ? 'port' : 'star';
};

// position d'amarrage le long de la tête du ponton
export const moorPose = (isl, s) => {
  const k = isl.dock, d = k.s1 + 1.7 + 0.5 + s.sp.B / 2;
  const t1 = k.a + Math.PI / 2, t2 = k.a - Math.PI / 2, first = Math.abs(wrap(s.th - t1)) < Math.abs(wrap(s.th - t2));
  return { x: isl.x + k.ux * d, z: isl.z + k.uz * d, th: first ? t1 : t2, side: first ? 1 : -1 };
};
export const placeAtDock = (s, isl) => {
  s.th = isl.dock.a + Math.PI / 2;
  const p = moorPose(isl, s);
  s.x = p.x; s.z = p.z; s.th = p.th; s.vx = s.vz = s.om = 0; s.sail = 0; s.helm = false; s.moored = isl; s.moorPose = p;
};
export const nearDock = (s) => {
  for (const isl of islands) { const p = moorPose(isl, s); if (dist(s.x, s.z, p.x, p.z) < 32) return isl; }
  return null;
};

// ---------- canons ----------
// solution de tir d'un bord : cible la plus proche de la perpendiculaire
export const solve = (s, side, targets, high) => {
  const perp = s.th + side * Math.PI / 2;
  let best = null, bestA = 0.62;
  targets.forEach((t) => {
    if (!t.alive || t === s) return;
    const d0 = dist(s.x, s.z, t.x, t.z);
    if (d0 > 125) return;
    const lead = d0 / BALL_V, tx = t.x + t.vx * lead, tz = t.z + t.vz * lead;
    const ang = wrap(Math.atan2(tx - s.x, tz - s.z) - perp);
    if (Math.abs(ang) < bestA) { bestA = Math.abs(ang); best = { t, ang, d: Math.hypot(tx - s.x, tz - s.z) }; }
  });
  if (!best) return { dist: 70, yaw: 0, h: 0.8, locked: false, target: null };
  const locked = Math.abs(best.ang) < 0.23;
  return { dist: Math.max(12, best.d - best.t.sp.B * 0.3), yaw: locked ? best.ang : 0, h: high ? best.t.sp.deckY + 7 : 0.8, locked, target: best.t };
};

export const fireBroadside = (s, side, sol) => {
  if (!s.alive || s.reload[side] > 0 || s.zones[side > 0 ? 'port' : 'star'].dead) return false;
  s.reload[side] = s.sp.reload / s.reloadMul;
  s.recoil[side] = 1; s.kick -= side * 0.05;
  const el = 0.5 * Math.asin(clamp((BALL_G * sol.dist) / (BALL_V * BALL_V), 0, 1)) + Math.atan2(sol.h - 2.2, sol.dist);
  s.model.cannons[side].forEach((c, i) => pending.push({ t: i * 0.08 + Math.random() * 0.05, s, side, c, el, yaw: sol.yaw }));
  return true;
};

const spawnBall = (p) => {
  const s = p.s;
  if (!s.alive) return;
  const x = s.x + toWorldX(p.c.x, p.c.z, s.th), z = s.z + toWorldZ(p.c.x, p.c.z, s.th), y = s.heave + p.c.y;
  const spread = s.kind === 'player' ? 0.022 : 0.045;
  const ang = s.th + p.side * Math.PI / 2 + p.yaw + (Math.random() - 0.5) * spread * 2, el = p.el + (Math.random() - 0.5) * spread;
  const m = getBall();
  m.position.set(x, y, z);
  balls.push({ x, y, z, vx: Math.sin(ang) * Math.cos(el) * BALL_V + s.vx * 0.5, vy: Math.sin(el) * BALL_V, vz: Math.cos(ang) * Math.cos(el) * BALL_V + s.vz * 0.5, owner: s, dmg: s.sp.dmg * s.dmgMul, life: 5, mesh: m });
  puff('flash', x, y, z, 1);
  puff('white', x + Math.sin(ang) * 1.2, y, z + Math.cos(ang) * 1.2, 4, { vx: Math.sin(ang) * 5, vz: Math.cos(ang) * 5 });
  sfxAt('cannon', x, z, 420);
  if (s === G.ship) shake(0.22);
};

const updateBalls = (dt) => {
  for (let i = pending.length - 1; i >= 0; i--) { pending[i].t -= dt; if (pending[i].t <= 0) { spawnBall(pending[i]); pending.splice(i, 1); } }
  const t = G.time, h = dt / 2;
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    let dead = false;
    for (let st = 0; st < 2 && !dead; st++) {
      b.vy -= BALL_G * h; b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
      for (let j = 0; j < G.ships.length && !dead; j++) {
        const s = G.ships[j];
        if (s === b.owner || !s.alive || (b.owner !== G.ship && s !== G.ship)) continue;
        const dx = b.x - s.x, dz = b.z - s.z;
        if (dx * dx + dz * dz > s.sp.L * s.sp.L) continue;
        const lx = toLocalX(dx, dz, s.th), lz = toLocalZ(dx, dz, s.th), ly = b.y - s.heave;
        if (Math.abs(lz) > s.sp.L / 2) continue;
        let hit = false;
        if (ly > -1.6 && ly < s.sp.deckY + 1.7) hit = Math.abs(lx) < s.model.hb(lz) + 0.45;
        else if (ly >= s.sp.deckY + 1.7 && !s.zones.mast.dead && Math.abs(lx) < s.sp.B * 0.72) hit = s.model.mastInfo.some((mi) => Math.abs(lz - mi.z) < 1.5 && ly < mi.top);
        if (!hit) continue;
        const zk = zoneAt(s, lx, ly, lz), byPlayer = b.owner === G.ship;
        damageShip(s, zk, b.dmg, { byPlayer });
        puff('wood', b.x, b.y, b.z, 9); puff('smoke', b.x, b.y, b.z, 2); puff('spark', b.x, b.y, b.z, 4);
        sfxAt('wood', b.x, b.z, 380);
        if (byPlayer) num(b.x, b.y + 1.5, b.z, String(Math.round(b.dmg)), zk === 'mast' ? 'sail' : 'hitn');
        if (s === G.ship) { shake(0.35); emit('deckHit', { x: b.x, y: b.y, z: b.z }); }
        dead = true;
      }
      if (!dead && b.y < waveH(b.x, b.z, t)) {
        if (groundAt(b.x, b.z) > -0.5) puff('dust', b.x, Math.max(b.y, 0.2), b.z, 6, { s: 1.6 });
        else { puff('splash', b.x, b.y + 0.2, b.z, 12, { s: 1.3 }); sfxAt('splash', b.x, b.z, 200); }
        dead = true;
      } else if (!dead && b.y < 12 && groundAt(b.x, b.z) > b.y) { puff('dust', b.x, b.y, b.z, 6, { s: 1.6 }); dead = true; }
    }
    b.life -= dt;
    if (dead || b.life <= 0) { freeBall(b.mesh); balls.splice(i, 1); } else b.mesh.position.set(b.x, b.y, b.z);
  }
};

// ---------- IA des navires : repos, patrouille, poursuite, attaque, retour ----------
const blocked = (x, z) => {
  if (inSafe(x, z)) return true;
  for (let i = 0; i < islands.length; i++) if (terrainH(islands[i], x, z) > -2.6) return true;
  for (let i = 0; i < shipCircles.length; i++) { const c = shipCircles[i]; if (Math.abs(c.x - x) < c.r + 9 && Math.abs(c.z - z) < c.r + 9) return true; }
  return false;
};
const steer = (s, hd) => { s.ctrlRudder = clamp(wrap(hd - s.th) * 1.7, -1, 1); };
const avoid = (s) => {
  const pr = (a, d) => blocked(s.x + Math.sin(a) * d, s.z + Math.cos(a) * d);
  if (pr(s.th, 28) || pr(s.th, 58)) {
    const l = pr(s.th + 0.85, 46), r = pr(s.th - 0.85, 46);
    if (!s.ai.av) s.ai.av = !l && r ? 1 : !r && l ? -1 : Math.random() < 0.5 ? 1 : -1;
    s.ctrlRudder = s.ai.av; s.sail = 1;
    return true;
  }
  s.ai.av = 0;
  return false;
};
const aiShip = (s, dt) => {
  const ai = s.ai, P = G.ship, pl = G.player;
  const can = P.alive && pl.aboard && !P.moored && !inSafe(P.x, P.z) && G.mode === 'play';
  const d = dist(s.x, s.z, P.x, P.z), brg = Math.atan2(P.x - s.x, P.z - s.z);
  const home = ai.route[ai.wp];
  ai.t += dt;
  s.helm = true;
  if (ai.state === 'repos') {
    s.helm = false; s.sail = 0; s.ctrlRudder = 0;
    if (can && d < ai.detect) { ai.state = 'poursuite'; emit('spotted', { ship: s }); }
    return;
  }
  if (ai.state === 'patrouille') {
    s.sail = 2;
    if (dist(s.x, s.z, home[0], home[1]) < 34) ai.wp = (ai.wp + 1) % ai.route.length;
    steer(s, Math.atan2(home[0] - s.x, home[1] - s.z));
    if (can && d < ai.detect) { ai.state = 'poursuite'; emit('spotted', { ship: s }); }
  } else if (ai.state === 'poursuite') {
    s.sail = 3;
    steer(s, brg);
    if (!can || d > 430) ai.state = 'retour';
    else if (d < 92) { ai.state = 'attaque'; ai.side = 0; }
  } else if (ai.state === 'attaque') {
    if (!can) ai.state = 'retour';
    else if (d > 150) ai.state = 'poursuite';
    else {
      // présenter un flanc valide à la cible, en gardant ses distances
      const okP = !s.zones.port.dead, okS = !s.zones.star.dead;
      const hp = brg - Math.PI / 2, hs = brg + Math.PI / 2;
      if (!ai.side || ai.t > 6) { ai.side = okP && (!okS || Math.abs(wrap(hp - s.th)) < Math.abs(wrap(hs - s.th))) ? 1 : -1; ai.t = 0; }
      let hd = ai.side > 0 ? hp : hs;
      const corr = d > 78 ? 0.55 : d < 42 ? -0.5 : 0;
      hd += ai.side > 0 ? corr : -corr;
      steer(s, hd);
      s.sail = d > 78 ? 3 : 2;
      [1, -1].forEach((sd) => {
        if (s.reload[sd] > 0) return;
        const sol = solve(s, sd, [P], false);
        if (sol.locked && sol.dist < 112) {
          sol.dist *= 1 + (Math.random() - 0.5) * 0.3; sol.yaw += (Math.random() - 0.5) * 0.08;
          fireBroadside(s, sd, sol);
        }
      });
    }
  } else if (ai.state === 'retour') {
    s.sail = 2;
    steer(s, Math.atan2(home[0] - s.x, home[1] - s.z));
    if (dist(s.x, s.z, home[0], home[1]) < 40) ai.state = ai.route.length > 1 ? 'patrouille' : 'repos';
    if (can && d < ai.detect * 0.7) ai.state = 'poursuite';
  }
  avoid(s);
  // coincé contre un obstacle : on vire franchement du même bord jusqu'à se dégager
  ai.stuck = s.sail > 0 && s.speed < 0.8 ? (ai.stuck || 0) + dt : 0;
  if (ai.stuck > 4) { ai.free = 5; ai.fdir = ai.fdir || (Math.random() < 0.5 ? 1 : -1); ai.stuck = 0; }
  if (ai.free > 0) {
    ai.free -= dt; s.ctrlRudder = ai.fdir; s.sail = 2;
    const isl = islands.reduce((a, b) => (dist(s.x, s.z, a.x, a.z) - a.r < dist(s.x, s.z, b.x, b.z) - b.r ? a : b));
    const dx = s.x - isl.x, dz = s.z - isl.z, d = Math.hypot(dx, dz) || 1;
    s.x += (dx / d) * dt * 2.5; s.z += (dz / d) * dt * 2.5;
    if (ai.free <= 0) ai.fdir = 0;
  }
};

export const spawnFleet = () => {
  for (let i = G.ships.length - 1; i >= 0; i--) if (G.ships[i] !== G.ship) { disposeShip(G.ships[i]); G.ships.splice(i, 1); }
  FLEET.forEach((f) => {
    const p = f.route[0], q = f.route[1] || [p[0] + 1, p[1]];
    const s = createShip(f.kind, p[0], p[1], Math.atan2(q[0] - p[0], q[1] - p[1]));
    s.ai = { state: f.route.length > 1 ? 'patrouille' : 'repos', route: f.route, wp: f.route.length > 1 ? 1 : 0, t: 0, side: 0, av: 0, detect: f.kind === 'galion' ? 230 : 200 };
    s.helm = true;
  });
};

// ---------- commandes du joueur à la barre ----------
const lookSide = () => { const r = wrap(G.cam.rel); return r > 0.6 && r < 2.6 ? 1 : r < -0.6 && r > -2.6 ? -1 : 0; };
const playerHelm = (s) => {
  const inp = G.input;
  s.ctrlRudder = clamp(-inp.mx, -1, 1);
  if (inp.sailUp && s.sail < 3) { s.sail++; sfx('sail'); emit('toast', { text: SAIL_LABEL[s.sail], key: 'sail' }); }
  if (inp.sailDown && s.sail > 0) { s.sail--; sfx('sail'); emit('toast', { text: SAIL_LABEL[s.sail], key: 'sail' }); }
  if (inp.shot) { s.shot = s.shot === 'hull' ? 'sails' : 'hull'; sfx('ui'); emit('toast', { text: s.shot === 'hull' ? 'Viser la coque' : 'Viser les voiles', key: 'shot' }); }
  let side = inp.fireL ? 1 : inp.fireR ? -1 : 0;
  if (!side && inp.fire) {
    side = lookSide();
    if (!side) { const a = solve(s, 1, G.ships, false), b = solve(s, -1, G.ships, false); side = a.locked ? 1 : b.locked ? -1 : 0; }
    if (!side) emit('toast', { text: 'Regarde à bâbord ou à tribord pour tirer', key: 'look' });
  }
  if (side) {
    const dead = s.zones[side > 0 ? 'port' : 'star'].dead;
    if (dead) emit('toast', { text: 'Canons hors service : répare le flanc', key: 'cdead' });
    else if (s.reload[side] > 0) sfx('ui', 0.5);
    else fireBroadside(s, side, solve(s, side, G.ships, s.shot === 'sails'));
  }
};

const mkArc = () => {
  const g = new THREE.RingGeometry(0.1, 1, 18, 1, Math.PI / 2 - 0.2, 0.4);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
  m.renderOrder = 4; m.visible = false;
  G.scene.add(m);
  return m;
};
const updateArcs = (s) => {
  if (!arcs) arcs = { 1: mkArc(), '-1': mkArc() };
  const atHelm = G.player.mode === 'helm' && s.alive, look = lookSide();
  [1, -1].forEach((sd) => {
    const m = arcs[sd];
    if (!atHelm || s.zones[sd > 0 ? 'port' : 'star'].dead) { m.visible = false; return; }
    const sol = solve(s, sd, G.ships, s.shot === 'sails');
    m.visible = look === sd || !!sol.target;
    if (!m.visible) return;
    // l'anneau est construit autour de -z local : on le tourne vers le bord visé
    m.position.set(s.x, 0.7, s.z);
    m.rotation.y = s.th + sd * Math.PI / 2 + sol.yaw + Math.PI;
    m.scale.setScalar(sol.dist + 6);
    const ready = s.reload[sd] <= 0;
    m.material.color.set(sol.locked ? 0xff5540 : 0xffffff);
    m.material.opacity = (ready ? 0.3 : 0.1) + (sol.locked && ready ? 0.12 : 0);
  });
};

// ---------- physique ----------
const hitCircle = (s, cx, cz, r) => {
  let pushed = false;
  for (let i = -1; i <= 1; i++) {
    const ox = s.x + Math.sin(s.th) * s.sp.L * 0.33 * i, oz = s.z + Math.cos(s.th) * s.sp.L * 0.33 * i;
    const dx = ox - cx, dz = oz - cz, rr = r + s.sp.B * 0.52, d2 = dx * dx + dz * dz;
    if (d2 < rr * rr && d2 > 1e-4) { const d = Math.sqrt(d2), k = (rr - d) / d; s.x += dx * k; s.z += dz * k; pushed = true; }
  }
  return pushed;
};

const collideShips = (a, b) => {
  const R2 = (a.sp.L + b.sp.L) * 0.5 + 6;
  if (Math.abs(a.x - b.x) > R2 || Math.abs(a.z - b.z) > R2) return;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const ax = a.x + Math.sin(a.th) * a.sp.L * 0.33 * i, az = a.z + Math.cos(a.th) * a.sp.L * 0.33 * i;
    const bx = b.x + Math.sin(b.th) * b.sp.L * 0.33 * j, bz = b.z + Math.cos(b.th) * b.sp.L * 0.33 * j;
    const dx = bx - ax, dz = bz - az, rr = (a.sp.B + b.sp.B) * 0.52, d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr || d2 < 1e-4) continue;
    const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, pen = rr - d, wa = b.sp.L / (a.sp.L + b.sp.L);
    a.x -= nx * pen * wa; a.z -= nz * pen * wa; b.x += nx * pen * (1 - wa); b.z += nz * pen * (1 - wa);
    const vn = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
    if (vn > 2.2 && a.ramCd <= 0 && b.ramCd <= 0 && (a === G.ship || b === G.ship)) {
      a.ramCd = b.ramCd = 1.6;
      // l'éperonneur est celui qui touche avec sa proue ; la victime prend le coup dans la zone touchée
      const zoneOf = (s, idx, px, pz) => (idx < 0 ? 'stern' : idx > 0 ? 'bow' : toLocalX(px - s.x, pz - s.z, s.th) > 0 ? 'port' : 'star');
      const cx = ax + nx * a.sp.B * 0.5, cz = az + nz * a.sp.B * 0.5;
      const za = zoneOf(a, i, cx, cz), zb = zoneOf(b, j, cx, cz), base = 5.5 * vn;
      const hit = (ram, vic, zr, zv) => {
        const eff = ram.zones.bow.dead ? 0.25 : 1;
        damageShip(vic, zv, base * eff, { byPlayer: ram === G.ship });
        damageShip(ram, zr, base * 0.25, { byPlayer: vic === G.ship });
        if (ram === G.ship) num(cx, 4, cz, String(Math.round(base * eff)), 'hitn');
      };
      if (za === 'bow' && zb !== 'bow') hit(a, b, za, zb);
      else if (zb === 'bow' && za !== 'bow') hit(b, a, zb, za);
      else { damageShip(a, za, base * 0.5, { byPlayer: b === G.ship }); damageShip(b, zb, base * 0.5, { byPlayer: a === G.ship }); }
      puff('wood', cx, 2, cz, 14); puff('splash', cx, 0.5, cz, 10); sfxAt('wood', cx, cz); shake(0.5);
      a.vx -= nx * vn * 0.6; a.vz -= nz * vn * 0.6; b.vx += nx * vn * 0.4; b.vz += nz * vn * 0.4;
    }
  }
};

const updateShip = (s, dt) => {
  const sp = s.sp, t = G.time, zn = s.zones;
  if (s.sink > 0) {
    s.sink += dt;
    s.heave -= dt * (0.5 + s.sink * 0.25); s.roll += dt * 0.09; s.pitch -= dt * 0.04;
    if (Math.random() < dt * 8) puff('splash', s.x + (Math.random() - 0.5) * sp.L * 0.7, 0.3, s.z + (Math.random() - 0.5) * sp.L * 0.7, 2);
    s.group.position.set(s.x, s.heave, s.z);
    s.group.rotation.set(-s.pitch, s.th, s.roll);
    if (s.sink > 9) s.group.visible = false;
    return;
  }
  if (s === G.ship) { if (G.player.mode === 'helm' && G.mode === 'play') playerHelm(s); else s.ctrlRudder = 0; }
  else if (G.mode === 'play') aiShip(s, dt);

  // amarrage : barre lâchée près d'un ponton, le navire vient se ranger
  if (s === G.ship && !s.helm) {
    s.sail = 0;
    if (!s.moored && s.speed < 9.5) { const isl = nearDock(s); if (isl) { s.moored = isl; s.moorPose = moorPose(isl, s); emit('moored', { isl }); } }
  }
  if (s.moored) {
    const p = s.moorPose;
    s.x = damp(s.x, p.x, 1.6, dt); s.z = damp(s.z, p.z, 1.6, dt); s.th = dampAngle(s.th, p.th, 1.6, dt);
    s.vx = s.vz = s.om = 0;
  } else {
    s.rudder = damp(s.rudder, s.ctrlRudder, 3.2, dt);
    const fx = Math.sin(s.th), fz = Math.cos(s.th);
    let vf = s.vx * fx + s.vz * fz, vl = s.vx * fz - s.vz * fx;
    const mastF = zn.mast.dead ? 0.42 : zn.mast.hp < zn.mast.max * 0.6 ? 0.8 : 1;
    const target = s.helm ? s.maxSpeed * SAILF[s.sail] * mastF * (1 - 0.22 * Math.abs(s.rudder)) : 0;
    vf = damp(vf, target, s.helm ? (target > vf ? 0.34 : 0.5) : 1.3, dt);
    vl = damp(vl, 0, 2.0, dt);
    const sr = Math.abs(vf) / s.maxSpeed;
    const omT = s.helm ? s.rudder * sp.turn * smooth(0, 0.22, sr) * (1 - 0.36 * sr) * (zn.stern.dead ? 0.38 : 1) : 0;
    s.om = damp(s.om, omT, 2.2, dt);
    s.th = wrap(s.th + s.om * dt);
    s.vx = vf * fx + vl * fz; s.vz = vf * fz - vl * fx;
    s.x += s.vx * dt; s.z += s.vz * dt;
    // hauts-fonds et obstacles fixes
    s.groundCd -= dt;
    for (let i = -1; i <= 1; i++) {
      const px = s.x + fx * sp.L * 0.42 * i, pz = s.z + fz * sp.L * 0.42 * i;
      for (let k = 0; k < islands.length; k++) {
        const isl = islands[k], h = terrainH(isl, px, pz);
        if (h > -sp.draft + 0.3) {
          const dx = px - isl.x, dz = pz - isl.z, d = Math.hypot(dx, dz) || 1, push = Math.min(1.5, (h + sp.draft - 0.3) * 0.12 + 0.05);
          s.x += (dx / d) * push; s.z += (dz / d) * push;
          const vn = (s.vx * dx + s.vz * dz) / d;
          if (vn < 0) { s.vx -= (dx / d) * vn; s.vz -= (dz / d) * vn; }
          if (s === G.ship && s.groundCd <= 0 && s.speed > 4.5) { s.groundCd = 2; damageShip(s, i > 0 ? 'bow' : i < 0 ? 'stern' : 'port', s.speed * 2.2); shake(0.5); sfx('wood'); emit('toast', { text: 'Échoué sur un haut-fond !', key: 'ground' }); }
          s.vx *= 0.9; s.vz *= 0.9;
        }
      }
    }
    for (let i = 0; i < shipCircles.length; i++) {
      const c = shipCircles[i];
      if (Math.abs(c.x - s.x) < 40 && Math.abs(c.z - s.z) < 40 && hitCircle(s, c.x, c.z, c.r)) { s.vx *= 0.94; s.vz *= 0.94; }
    }
    const dc = dist(s.x, s.z, WORLD.cx, WORLD.cz);
    if (dc > WORLD.radius) {
      const k = (dc - WORLD.radius) / dc;
      s.x -= (s.x - WORLD.cx) * k; s.z -= (s.z - WORLD.cz) * k; s.vx *= 0.9; s.vz *= 0.9;
      if (s === G.ship) emit('toast', { text: 'Courants contraires : la carte s’arrête ici', key: 'edge' });
    }
  }
  s.speed = Math.hypot(s.vx, s.vz);
  s.ramCd -= dt;
  [1, -1].forEach((sd) => {
    if (s.reload[sd] > 0) { s.reload[sd] -= dt; if (s.reload[sd] <= 0 && s === G.ship && G.player.mode === 'helm') sfx('ui', 0.6); }
    s.recoil[sd] = damp(s.recoil[sd], 0, 5, dt);
    s.model.cannonMesh[sd].position.x = -sd * s.recoil[sd] * 0.45;
  });
  // voies d'eau
  const leaks = (zn.port.dead ? 1 : 0) + (zn.star.dead ? 1 : 0);
  if (leaks) { s.hull -= leaks * (s === G.ship ? 4.5 : s.hullMax * 0.035) * dt; if (s.hull <= 0) sinkShip(s, s !== G.ship); }

  // flottabilité : la coque suit la houle (4 points de mesure)
  const fx = Math.sin(s.th), fz = Math.cos(s.th), mo = s.moored ? 0.35 : 1;
  const hb = waveH(s.x + fx * sp.L * 0.38, s.z + fz * sp.L * 0.38, t), hs = waveH(s.x - fx * sp.L * 0.38, s.z - fz * sp.L * 0.38, t);
  const hl = waveH(s.x + fz * sp.B * 0.45, s.z - fx * sp.B * 0.45, t), hr = waveH(s.x - fz * sp.B * 0.45, s.z + fx * sp.B * 0.45, t);
  const low = 1 - s.hull / s.hullMax;
  s.heave = damp(s.heave, ((hb + hs + hl + hr) / 4) * mo - low * 0.55, 3.2, dt);
  s.pitch = damp(s.pitch, Math.atan2(hb - hs, sp.L * 0.76) * mo, 2.6, dt);
  s.kick = damp(s.kick, 0, 3, dt);
  const heel = s.om * s.speed * 0.021 + (zn.port.dead ? 0.05 : 0) - (zn.star.dead ? 0.05 : 0);
  s.roll = damp(s.roll, Math.atan2(hl - hr, sp.B * 0.9) * 0.8 * mo + heel + s.kick, 2.6, dt);
  s.group.position.set(s.x, s.heave, s.z);
  s.group.rotation.set(-s.pitch, s.th, s.roll);

  // gréement
  s.sailVis = damp(s.sailVis, s.sail / 3, 1.8, dt);
  const sv = lerp(0.1, 1, s.sailVis);
  s.model.sails.forEach((m, i) => {
    if (m.userData.jib) { m.visible = s.sailVis > 0.15; return; }
    m.scale.y = sv; m.scale.z = 0.35 + s.sailVis * (0.85 + Math.sin(t * 2.3 + i) * 0.12);
  });
  s.model.wheel.rotation.z = -s.rudder * 2.4;

  // sillage, écume d'étrave, fumée des zones détruites
  const cam = G.camera.position;
  if (Math.abs(cam.x - s.x) < 420 && Math.abs(cam.z - s.z) < 420) {
    s.fxT += dt * (0.5 + s.speed * 0.9);
    while (s.fxT > 1) {
      s.fxT -= 1;
      if (s.speed > 1) {
        const sd = Math.random() < 0.5 ? 1 : -1, bx = s.x + fx * sp.L * 0.4, bz = s.z + fz * sp.L * 0.4;
        puff('foam', bx + fz * sd * 1.2, 0, bz - fx * sd * 1.2, 1, { vx: fz * sd * 2.2 + s.vx * 0.25, vz: -fx * sd * 2.2 + s.vz * 0.25 });
        puff('foam', s.x - fx * sp.L * 0.5, 0, s.z - fz * sp.L * 0.5, 1, { spread: sp.B * 0.6 });
      }
      if (s.speed > s.maxSpeed * 0.55 && s.pitch < -0.02 && Math.random() < 0.5) puff('splash', s.x + fx * sp.L * 0.5, 0.6, s.z + fz * sp.L * 0.5, 3, { vx: s.vx * 0.5, vz: s.vz * 0.5 });
    }
    if (Math.random() < dt * 5) {
      const zs = [['bow', 0, 0.4], ['port', 1, 0], ['star', -1, 0], ['stern', 0, -0.42]];
      zs.forEach(([zk, sx, sz]) => {
        if (!zn[zk].dead) return;
        const lx = sx * sp.B * 0.4, lz = sz * sp.L, x = s.x + toWorldX(lx, lz, s.th), z = s.z + toWorldZ(lx, lz, s.th);
        puff('smoke', x, s.heave + sp.deckY + 0.5, z, 1); puff('fire', x, s.heave + sp.deckY + 0.3, z, 1);
      });
    }
  }
};

export const updateShips = (dt) => {
  for (let i = 0; i < G.ships.length; i++) updateShip(G.ships[i], dt);
  for (let i = 0; i < G.ships.length; i++) for (let j = i + 1; j < G.ships.length; j++) {
    const a = G.ships[i], b = G.ships[j];
    if (a.alive && b.alive && !a.moored && !b.moored) collideShips(a, b);
  }
  updateBalls(dt);
  updateArcs(G.ship);
};

export const knots = (s) => s.speed * 0.82;
