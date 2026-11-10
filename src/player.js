import { G, emit } from './state.js';
import { clamp, damp, dampAngle, wrap, toWorldX, toWorldZ, toLocalX, toLocalZ } from './util.js';
import { PLAYER, ZONES, ZONE_LABEL } from './config.js';
import { makeRig, animateRig } from './charmodel.js';
import { groundAt, gi, collideWorld, interactables, chests } from './world.js';
import { repairZone } from './ship.js';
import { puff, shake, slash, tracer, num } from './fx.js';
import { sfx } from './audio.js';
import { damageEnemy } from './enemies.js';

const ATK = { a1: { dur: 0.42, hit: 0.42, next: 'a2', dmg: 0 }, a2: { dur: 0.42, hit: 0.42, next: 'a3', dmg: 1 }, a3: { dur: 0.6, hit: 0.44, next: null, dmg: 2 }, heavy: { dur: 0.95, hit: 0.6, next: null } };

export const createPlayer = () => {
  const rig = makeRig({ weapon: 'player', coat: 0x1f4a66, pants: 0x3b3a44, hat: 'tricorn', hatCol: 0x1b1d22, beard: 0x3a2a1c });
  G.player = {
    rig, mode: 'deck', lx: 0, lz: 0, jy: 0, x: 0, y: 0, z: 0, vy: 0, yaw: 0, grounded: true, aboard: true, speed: 0,
    hp: PLAYER.hp, maxHp: PLAYER.hp, st: PLAYER.stamina, maxSt: PLAYER.stamina, stDelay: 0, ammo: PLAYER.ammoMax, dmgMul: 1,
    act: null, actT: 0, actDur: 0, queued: false, hitDone: false, iframes: 0, reloadT: 0, aiming: false, aimT: 0, recoil: 0,
    dead: false, deadT: 0, parryT: 0, hurtT: 0, holdT: 0, plankAcc: 0, repT: 0, rollX: 0, rollZ: 0, lvl: 1, radius: 0.45, stepT: 0,
  };
  return G.player;
};

const setParent = (p, parent) => { parent.add(p.rig.root); };

export const toDeck = (p, lx, lz) => {
  const s = G.ship;
  p.mode = 'deck'; p.aboard = true; p.lx = lx; p.lz = lz; p.jy = 0; p.vy = 0; p.grounded = true;
  setParent(p, s.group);
  s.helm = false;
};
export const toWorld = (p, x, z, yaw) => {
  p.mode = 'world'; p.aboard = false; p.x = x; p.z = z; p.y = groundAt(x, z); p.vy = 0; p.grounded = true; p.yaw = yaw; p.act = null; p.dead = false;
  setParent(p, G.scene);
  G.ship.helm = false;
};
export const respawnOnDeck = (p) => {
  const s = G.ship;
  toDeck(p, 0, s.model.helm.z + 2.5);
  p.yaw = s.th; p.act = null; p.dead = false; p.iframes = 1.5;
};
const takeHelm = (p) => {
  const s = G.ship;
  p.mode = 'helm'; p.lx = s.model.helm.x; p.lz = s.model.helm.z; p.jy = 0; p.act = null; p.aiming = false;
  s.helm = true; s.moored = null;
  G.cam.rel = 0;
  sfx('creak');
  emit('helm', { on: true });
};
const leaveHelm = (p) => { p.mode = 'deck'; G.ship.helm = false; G.cam.yaw = G.ship.th + G.cam.rel; sfx('creak'); emit('helm', { on: false }); };

// position monde approchée du joueur (sans le roulis du navire)
const syncWorld = (p) => {
  if (p.mode === 'world') return;
  const s = G.ship;
  p.x = s.x + toWorldX(p.lx, p.lz, s.th); p.z = s.z + toWorldZ(p.lx, p.lz, s.th);
  p.y = s.heave + s.model.deckAt(p.lz) + p.jy;
};

const start = (p, name, dur) => { p.act = name; p.actT = 0; p.actDur = dur; p.hitDone = false; p.queued = false; };
const busy = (p) => p.act === 'roll' || p.act === 'hit' || p.act === 'dead' || !!ATK[p.act];

const nearestFoe = (p, range, cone, yaw) => {
  let best = null, bd = range;
  G.enemies.forEach((e) => {
    if (!e.alive) return;
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    if (d < bd && Math.abs(wrap(Math.atan2(e.x - p.x, e.z - p.z) - yaw)) < cone) { bd = d; best = e; }
  });
  return best;
};

const meleeHit = (p, heavy, idx) => {
  let any = false;
  const dmg = (heavy ? PLAYER.heavy : PLAYER.light[idx]) * p.dmgMul;
  G.enemies.forEach((e) => {
    if (!e.alive) return;
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    if (d > PLAYER.reach + e.radius + (heavy ? 0.4 : 0) || Math.abs(e.y - p.y) > 2.2) return;
    if (d > 0.8 && Math.abs(wrap(Math.atan2(e.x - p.x, e.z - p.z) - p.yaw)) > 1.2) return;
    damageEnemy(e, dmg, { heavy, fx: p.x, fz: p.z });
    any = true;
  });
  if (any) { G.hitStop = heavy ? 0.1 : 0.05; shake(heavy ? 0.4 : 0.18); sfx('cut'); }
};

const shoot = (p) => {
  const cam = G.camera, c = G.cam;
  if (p.ammo <= 0) { emit('toast', { text: 'Plus de munitions : le marchand du port en donne', key: 'ammo' }); sfx('ui', 0.5); return; }
  const charged = p.lvl >= 5 && p.aimT > 1.3;
  const cp = Math.cos(c.pitch), dx = Math.sin(c.yaw) * cp, dy = -Math.sin(c.pitch), dz = Math.cos(c.yaw) * cp;
  const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z, assist = G.isTouch ? 1.5 : 0.45;
  const hits = [];
  G.enemies.forEach((e) => {
    if (!e.alive) return;
    const ex = e.x - ox, ey = e.y + 1.1 * e.scale - oy, ez = e.z - oz, t = ex * dx + ey * dy + ez * dz;
    if (t < 1 || t > 75) return;
    const perp = Math.hypot(ex - dx * t, ey - dy * t, ez - dz * t);
    if (perp < 0.7 * e.scale + assist * Math.min(1, t / 12)) hits.push({ e, t });
  });
  hits.sort((a, b) => a.t - b.t);
  const mx = p.x + Math.sin(p.yaw) * 0.9, my = p.y + 1.45, mz = p.z + Math.cos(p.yaw) * 0.9;
  let end = 70;
  (charged ? hits : hits.slice(0, 1)).forEach((h, i) => {
    damageEnemy(h.e, (charged ? PLAYER.charged : PLAYER.musket) * p.dmgMul, { musket: true, fx: p.x, fz: p.z });
    if (i === 0 && !charged) end = h.t;
  });
  tracer(mx, my, mz, ox + dx * end, oy + dy * end, oz + dz * end, charged ? 0xff9a50 : 0xfff0b0);
  puff('flash', mx, my, mz, 1, { s: 0.5 }); puff('white', mx, my, mz, 3, { s: 0.6 });
  sfx('musket'); shake(charged ? 0.45 : 0.28);
  p.ammo--; p.reloadT = p.ammo > 0 ? PLAYER.reload : 0; p.recoil = 0.001; p.aimT = 0;
  if (hits.length) G.hitStop = 0.06;
};

// Point d'entrée unique des dégâts reçus par le joueur. Renvoie 'miss', 'blocked', 'parried' ou 'hit'.
export const damagePlayer = (dmg, src = {}) => {
  const p = G.player;
  if (p.dead || p.iframes > 0 || G.mode !== 'play') return 'miss';
  if (p.act === 'parry' && src.x !== undefined) {
    const ang = Math.abs(wrap(Math.atan2(src.x - p.x, src.z - p.z) - p.yaw));
    if (ang < 1.35) {
      const perfect = p.parryT < 0.28;
      puff('spark', p.x + Math.sin(p.yaw) * 0.7, p.y + 1.3, p.z + Math.cos(p.yaw) * 0.7, 8);
      sfx('clang'); shake(0.2);
      if (!perfect) { p.st -= PLAYER.parryHit * (src.ranged ? 1.5 : 1); p.stDelay = 0.7; }
      if (p.st > 0) { if (perfect) { G.hitStop = 0.08; num(p.x, p.y + 2.2, p.z, 'Parade !', 'good'); } return perfect ? 'parried' : 'blocked'; }
      p.st = 0; dmg *= 0.5; // garde brisée
    }
  }
  p.hp -= dmg; p.hurtT = 0.4; p.rig.flash = 1; p.iframes = 0.5; // court répit : pas de coups en chaîne
  shake(0.35); sfx('hurt');
  emit('hurt', { dmg });
  if (p.hp <= 0) { p.hp = 0; p.dead = true; p.deadT = 0; start(p, 'dead', 1.7); p.aiming = false; emit('toast', { text: src.sea ? 'Assommé par un éclat de bois' : 'Tu es tombé', key: 'dead' }); }
  else if (p.act !== 'roll' && !(ATK[p.act] && (p.act === 'heavy' || p.actT / p.actDur > 0.2))) start(p, 'hit', 0.28); // un coup déjà lancé part quand même
  return 'hit';
};

const findInteract = (p) => {
  const s = G.ship;
  if (p.mode === 'helm') return { id: 'leave', text: 'Lâcher la barre' };
  if (p.mode === 'deck') {
    const h = s.model.helm;
    if (Math.hypot(p.lx - h.x, p.lz - h.z) < 1.5) return { id: 'helm', text: 'Prendre la barre' };
    let best = null;
    ZONES.forEach((zk) => {
      const r = s.model.repair[zk], z = s.zones[zk];
      if (z.hp < z.max - 0.5 && Math.hypot(p.lx - r.x, p.lz - r.z) < 1.9) best = { id: 'repair', zone: zk, text: `Colmater : ${ZONE_LABEL[zk]}`, hold: true };
    });
    return best;
  }
  let best = null, bd = 99;
  interactables.forEach((it) => { const d = Math.hypot(it.x - p.x, it.z - p.z); if (d < it.r && d < bd) { bd = d; best = { id: 'port', obj: it, text: it.label }; } });
  chests.forEach((c) => { const d = Math.hypot(c.x - p.x, c.z - p.z); if (!c.open && d < c.r && d < bd) { bd = d; best = { id: 'chest', obj: c, text: 'Ouvrir le coffre', hold: true }; } });
  return best;
};

export const updatePlayer = (dt) => {
  const p = G.player, s = G.ship, inp = G.input, c = G.cam;
  syncWorld(p);
  p.iframes -= dt; p.hurtT -= dt;
  if (p.aboard && !p.dead) p.hp = Math.min(p.maxHp, p.hp + 5 * dt);

  if (p.dead) {
    p.deadT += dt; p.actT += dt;
    animateRig(p.rig, { action: 'dead', u: p.actT / 1.2 }, dt);
    if (p.deadT > 1.9) emit('playerDied', {});
    G.prompt = null;
    return;
  }

  // ----- interactions -----
  const it = findInteract(p);
  let repairing = false;
  G.prompt = it ? { text: it.text, hold: !!it.hold, prog: 0 } : null;
  if (it && !busy(p)) {
    if (it.id === 'leave' && inp.interact) leaveHelm(p);
    else if (it.id === 'helm' && inp.interact) takeHelm(p);
    else if (it.id === 'port' && inp.interact) emit('openPort', { tab: it.obj.tab });
    else if (it.id === 'repair' && inp.interactHeld) {
      if (G.save.planks <= 0) emit('toast', { text: 'Plus de planches : le chantier du port en vend', key: 'planks' });
      else {
        repairing = true;
        repairZone(s, it.zone, 16 * dt);
        p.plankAcc += (16 * dt) / 12;
        if (p.plankAcc >= 1) { p.plankAcc -= 1; G.save.planks--; }
        p.repT -= dt;
        if (p.repT <= 0) { p.repT = 0.32; sfx('repair'); puff('wood', p.x, p.y + 0.4, p.z, 2, { s: 0.4 }); }
        const z = s.zones[it.zone];
        G.prompt.prog = z.hp / z.max;
      }
    } else if (it.id === 'chest' && inp.interactHeld) {
      p.holdT += dt; G.prompt.prog = p.holdT / it.obj.hold;
      if (p.holdT >= it.obj.hold) { p.holdT = 0; it.obj.open = true; it.obj.lid.rotation.x = -1.9; sfx('chest'); puff('gold', it.obj.x, it.obj.y + 0.8, it.obj.z, 14); emit('chest', { chest: it.obj }); }
    } else p.holdT = 0;
  }

  if (p.mode === 'helm') {
    p.lx = s.model.helm.x; p.lz = s.model.helm.z; p.yaw = s.th; p.speed = 0;
    p.rig.root.position.set(p.lx, s.model.deckAt(p.lz), p.lz);
    p.rig.root.rotation.y = 0;
    animateRig(p.rig, { action: 'helm', rud: s.rudder }, dt);
    p.st = Math.min(p.maxSt, p.st + PLAYER.staminaRegen * dt);
    return;
  }

  // ----- actions -----
  const fwdX = Math.sin(c.yaw), fwdZ = Math.cos(c.yaw);
  let wx = fwdX * inp.my - fwdZ * inp.mx, wz = fwdZ * inp.my + fwdX * inp.mx;
  const mag = Math.min(1, Math.hypot(wx, wz));
  if (mag > 0.01) { const m = Math.hypot(wx, wz); wx /= m; wz /= m; }
  const canAct = !busy(p) && !repairing;
  const wantAim = inp.aim && canAct && p.act !== 'parry';
  if (wantAim && !p.aiming) { p.aimT = 0; emit('aimStart', {}); }
  p.aiming = wantAim;
  if (p.aiming) { if (p.reloadT <= 0) p.aimT += dt; if (inp.fire && p.reloadT <= 0) shoot(p); }
  else if (canAct) {
    if (inp.roll && p.st >= PLAYER.rollCost && p.grounded) {
      start(p, 'roll', 0.55);
      p.st -= PLAYER.rollCost; p.stDelay = 0.6; p.iframes = 0.42;
      const a = mag > 0.1 ? Math.atan2(wx, wz) : p.yaw;
      p.rollX = Math.sin(a); p.rollZ = Math.cos(a); p.yaw = a;
      if (p.reloadT > 0) p.reloadT = PLAYER.reload; // l'esquive interrompt le rechargement
      sfx('roll'); puff('dust', p.x, p.y + 0.2, p.z, 4);
    } else if (inp.heavy && p.lvl >= 3 && p.st >= PLAYER.heavyCost) {
      start(p, 'heavy', ATK.heavy.dur); p.st -= PLAYER.heavyCost; p.stDelay = 0.8;
    } else if (inp.attack) start(p, 'a1', ATK.a1.dur);
    else if (inp.parry && p.lvl >= 2 && p.st > 2) { if (p.act !== 'parry') { p.act = 'parry'; p.parryT = 0; const f = nearestFoe(p, 6, 3.2, p.yaw); if (f) p.yaw = Math.atan2(f.x - p.x, f.z - p.z); } }
    else if (p.act === 'parry') p.act = null;
    if (inp.jump && p.grounded && !ATK[p.act]) { p.vy = PLAYER.jump; p.grounded = false; }
  }
  if (ATK[p.act] && inp.attack && p.actT > 0.12) p.queued = true;
  if (p.act === 'parry') { const f = nearestFoe(p, 5, 3.2, p.yaw); if (f && f.state === 'attaque') p.yaw = dampAngle(p.yaw, Math.atan2(f.x - p.x, f.z - p.z), 8, dt); p.parryT += dt; p.st -= PLAYER.parryDrain * dt; p.stDelay = 0.5; if (p.st <= 0 || !inp.parry) p.act = null; }

  // progression de l'action en cours
  let moveSpeed = PLAYER.run * mag, lunge = 0;
  if (p.act && p.act !== 'parry') {
    p.actT += dt;
    const u = p.actT / p.actDur, A = ATK[p.act];
    if (A) {
      if (p.actT < dt * 1.5) {
        const tgt = nearestFoe(p, 5, 2.0, mag > 0.1 ? Math.atan2(wx, wz) : p.yaw);
        if (tgt) p.yaw = Math.atan2(tgt.x - p.x, tgt.z - p.z); else if (mag > 0.1) p.yaw = Math.atan2(wx, wz);
        p.lungeGap = tgt ? Math.hypot(tgt.x - p.x, tgt.z - p.z) - tgt.radius - 1.3 : 1.2;
      }
      moveSpeed = 0;
      if (u > 0.22 && u < A.hit + 0.08) lunge = clamp(p.lungeGap * 6, 0, p.act === 'heavy' ? 5 : 6.5);
      if (!p.hitDone && u >= A.hit - 0.1) {
        p.hitDone = true;
        const heavy = p.act === 'heavy';
        slash(p.x, p.y + (heavy || p.act === 'a3' ? 1.0 : 1.25), p.z, p.yaw, p.act === 'a2' ? 0.25 : p.act === 'a1' ? -0.25 : 0, heavy ? 0xffc070 : 0xffffff, heavy ? 1.25 : 1);
        sfx('swing', heavy ? 1 : 0.8);
        meleeHit(p, heavy, A.dmg);
        p.stDelay = Math.max(p.stDelay, 0.35);
      }
      if (u >= 1 || (p.queued && A.next && u > 0.62)) { if (p.queued && A.next) start(p, A.next, ATK[A.next].dur); else p.act = null; }
    } else if (p.act === 'roll') { moveSpeed = 0; if (u >= 1) p.act = null; }
    else if (p.act === 'hit') { moveSpeed *= 0.2; if (u >= 1) p.act = null; }
  }
  const reloading = p.reloadT > 0 && !busy(p) && p.act !== 'parry';
  if (reloading) { p.reloadT -= dt; if (p.reloadT <= 0) sfx('ui', 0.7); }
  if (p.aiming || reloading || p.act === 'parry' || repairing) moveSpeed = Math.min(moveSpeed, repairing ? 0 : PLAYER.slow);
  if (p.recoil > 0) { p.recoil += dt * 3; if (p.recoil >= 1) p.recoil = 0; }
  p.stDelay -= dt;
  if (p.stDelay <= 0) p.st = Math.min(p.maxSt, p.st + PLAYER.staminaRegen * dt);

  // ----- déplacement -----
  let mvx = wx * moveSpeed, mvz = wz * moveSpeed;
  if (p.act === 'roll') { const k = 9.5 * (1 - (p.actT / p.actDur) * 0.5); mvx = p.rollX * k; mvz = p.rollZ * k; }
  if (lunge) { mvx = Math.sin(p.yaw) * lunge; mvz = Math.cos(p.yaw) * lunge; }
  p.speed = damp(p.speed, Math.hypot(mvx, mvz), 14, dt);
  if (p.aiming) p.yaw = dampAngle(p.yaw, c.yaw, 20, dt);
  else if (mag > 0.1 && moveSpeed > 0 && !ATK[p.act] && p.act !== 'roll') p.yaw = dampAngle(p.yaw, Math.atan2(wx, wz), 13, dt);
  p.vy -= PLAYER.gravity * dt;

  if (p.mode === 'deck') {
    const m = s.model;
    p.lx += toLocalX(mvx, mvz, s.th) * dt; p.lz += toLocalZ(mvx, mvz, s.th) * dt;
    p.lz = clamp(p.lz, m.walkMinZ, m.walkMaxZ);
    const side = s.moored ? s.moorPose.side : 0, gang = side && Math.abs(p.lz) < 1.5;
    const lim = Math.max(0.25, m.hb(p.lz) - 0.5);
    if (gang && p.lx * side > 0) p.lx = side * Math.min(p.lx * side, lim + 1.2); else p.lx = clamp(p.lx, -lim, lim);
    [[0, m.helm.z + 0.75, 0.45], ...m.mastInfo.map((mi) => [0, mi.z, 0.6])].forEach(([ox, oz, r]) => {
      const dx = p.lx - ox, dz = p.lz - oz, d = Math.hypot(dx, dz);
      if (d < r + 0.35 && d > 1e-4) { p.lx = ox + (dx / d) * (r + 0.35); p.lz = oz + (dz / d) * (r + 0.35); }
    });
    p.jy += p.vy * dt;
    if (p.jy <= 0) { p.jy = 0; p.vy = 0; p.grounded = true; }
    if (gang && p.lx * side > m.hb(p.lz) + 0.1) {
      // passerelle : on passe du pont au ponton sans coupure
      syncWorld(p);
      p.mode = 'world'; p.aboard = false; p.y = Math.max(p.y, groundAt(p.x, p.z));
      setParent(p, G.scene);
      emit('landed', { isl: s.moored });
    }
  } else {
    const isl0 = (groundAt(p.x, p.z), gi.isl), onPier = gi.pier;
    const tryMove = (nx, nz) => {
      const g = groundAt(nx, nz);
      if (p.grounded && g > p.y + 0.7) return false;
      if (g < -0.3 && !onPier && p.grounded) return false;
      p.x = nx; p.z = nz;
      return true;
    };
    const nx = p.x + mvx * dt, nz = p.z + mvz * dt;
    if (!tryMove(nx, nz)) { if (!tryMove(nx, p.z)) tryMove(p.x, nz); }
    collideWorld(p, p.radius, isl0);
    G.enemies.forEach((e) => {
      if (!e.alive || p.act === 'roll') return;
      const dx = p.x - e.x, dz = p.z - e.z, d = Math.hypot(dx, dz), rr = p.radius + e.radius;
      if (d < rr && d > 1e-4) { p.x += (dx / d) * (rr - d); p.z += (dz / d) * (rr - d); }
    });
    const g = groundAt(p.x, p.z);
    p.y += p.vy * dt;
    if (p.y <= g) { if (!p.grounded && p.vy < -6) puff('dust', p.x, g + 0.1, p.z, 3); p.y = g; p.vy = 0; p.grounded = true; }
    else if (p.y > g + 0.15) p.grounded = false;
    if (p.y < -0.6) {
      puff('splash', p.x, 0.2, p.z, 14); sfx('splash');
      emit('toast', { text: 'À l’eau ! Tu remontes sur le pont.', key: 'water' });
      respawnOnDeck(p);
      emit('boarded', {});
    } else if (s.moored && s.alive) {
      // retour à bord par la passerelle
      const dx = p.x - s.x, dz = p.z - s.z, lx = toLocalX(dx, dz, s.th), lz = toLocalZ(dx, dz, s.th), side = s.moorPose.side, hb = s.model.hb(lz);
      if (Math.abs(lz) < 1.6 && lx * side < hb - 0.2 && lx * side > hb - 1.8 && p.y > s.sp.deckY - 0.9) {
        toDeck(p, lx, lz);
        emit('boarded', {});
      }
    }
  }

  // ----- rendu du personnage -----
  syncWorld(p);
  if (p.mode === 'world') { p.rig.root.position.set(p.x, p.y, p.z); p.rig.root.rotation.y = p.yaw; }
  else { p.rig.root.position.set(p.lx, s.model.deckAt(p.lz) + p.jy, p.lz); p.rig.root.rotation.y = p.yaw - s.th; }
  const showGun = p.aiming || reloading;
  p.rig.gun.visible = showGun; p.rig.gunBack.visible = !showGun; p.rig.saber.visible = !showGun;
  p.stepT -= dt * p.speed;
  if (p.stepT < 0 && p.grounded && p.speed > 2) { p.stepT = 2.6; if (p.mode === 'world' && !gi.pier) puff('dust', p.x, p.y + 0.05, p.z, 1, { s: 0.5 }); }
  animateRig(p.rig, {
    speed: p.speed, air: !p.grounded,
    action: repairing ? 'repair' : p.act || (p.aiming ? 'aim' : reloading ? 'reload' : null),
    u: p.act && p.act !== 'parry' ? p.actT / p.actDur : p.recoil, aimPitch: c.pitch * 0.8,
  }, dt);
};
