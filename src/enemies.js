import { THREE } from './three.js';
import { G, emit } from './state.js';
import { clamp, damp, dampAngle, wrap, rnd, dist } from './util.js';
import { FOES } from './config.js';
import { makeRig, animateRig, disposeRig } from './charmodel.js';
import { groundAt, collideWorld, dropLoot, rollLoot } from './world.js';
import { puff, shake, slash, tracer, ring, num } from './fx.js';
import { sfxAt } from './audio.js';
import { damagePlayer } from './player.js';

// IA à pied : cinq états (repos, patrouille, poursuite, attaque, retour).
const AGGRO = 17, LEASH = 48;
const bullets = [];
let bulletGeo, bulletMat;

let barGeo = null;
const mkBar = () => {
  if (!barGeo) { barGeo = new THREE.PlaneGeometry(1, 1); barGeo.translate(0.5, 0, 0); }
  const grp = new THREE.Group();
  const bg = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({ color: 0x0b1820, fog: false }));
  const fg = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({ color: 0xd9412f, fog: false }));
  bg.scale.set(1.1, 0.14, 1); bg.position.set(-0.55, 0, 0);
  fg.scale.set(1.04, 0.08, 1); fg.position.set(-0.52, 0, 0.01);
  grp.add(bg, fg); grp.visible = false; grp.renderOrder = 6;
  G.scene.add(grp);
  return { grp, bg, fg };
};

const spawn = (type, x, z, isl, camp, weak) => {
  const def = FOES[type], k = weak ? 0.7 : 1;
  const rig = makeRig({ ...def, bare: type === 'brute' || type === 'boucher', beard: def.boss ? 0x2a2019 : undefined });
  G.scene.add(rig.root);
  const e = {
    type, def, rig, x, y: groundAt(x, z), z, yaw: Math.random() * 6.28, hp: def.hp * k, maxHp: def.hp * k, dmg: def.dmg * k, alive: true,
    scale: def.scale, radius: 0.42 * def.scale * (def.bulk || 1), home: { x, z }, isl, camp, state: 'repos', t: rnd(1, 4), act: null, actT: 0, actDur: 0,
    hitDone: false, cd: rnd(0.3, 1.2), cd2: 3, stag: 0, sp: 0, kx: 0, kz: 0, bar: mkBar(), deadT: 0, poise: 0, phase: 0, back: 0, strafe: Math.random() < 0.5 ? 1 : -1, wp: null, combo: 0, aimT: 0,
  };
  G.enemies.push(e);
  return e;
};

export const activateIsland = (isl) => {
  isl.camps.forEach((c) => {
    c.left = c.foes.length;
    c.foes.forEach((type, i) => {
      const a = (i / c.foes.length) * 6.28 + 0.7, r = c.foes.length > 1 ? 3 + (i % 2) * 2.5 : 0;
      spawn(type, c.x + Math.sin(a) * r, c.z + Math.cos(a) * r, isl, c, c.weak);
    });
  });
};
export const deactivateIsland = (isl) => {
  for (let i = G.enemies.length - 1; i >= 0; i--) if (G.enemies[i].isl === isl) { remove(G.enemies[i]); G.enemies.splice(i, 1); }
  bullets.forEach((b) => { b.mesh.visible = false; });
  bullets.length = 0;
  G.boss = null;
};
const remove = (e) => { G.scene.remove(e.bar.grp); e.bar.bg.material.dispose(); e.bar.fg.material.dispose(); disposeRig(e.rig); };

// Point d'entrée unique des dégâts infligés aux ennemis.
export const damageEnemy = (e, dmg, o = {}) => {
  if (!e.alive) return;
  e.hp -= dmg; e.rig.flash = 1;
  num(e.x, e.y + 2.1 * e.scale, e.z, String(Math.round(dmg)), o.heavy || o.musket ? 'crit' : 'hitn');
  puff('hit', e.x, e.y + 1.2 * e.scale, e.z, o.heavy || o.musket ? 12 : 6);
  if (e.state === 'repos' || e.state === 'patrouille' || e.state === 'retour') e.state = 'poursuite';
  G.enemies.forEach((m) => { if (m.alive && m.camp === e.camp && (m.state === 'repos' || m.state === 'patrouille')) m.state = 'poursuite'; });
  const big = e.type === 'brute' || e.type === 'boucher', boss = e.type === 'capitaine';
  const dx = e.x - (o.fx ?? e.x), dz = e.z - (o.fz ?? e.z), d = Math.hypot(dx, dz) || 1, kb = (o.heavy ? 5 : 2.5) / (big || boss ? 2.5 : 1);
  e.kx = (dx / d) * kb; e.kz = (dz / d) * kb;
  if (boss) { e.poise += dmg; if (e.poise > 95 || o.heavy) { e.poise = 0; e.stag = 0.8; e.act = null; } }
  else if (!big || o.heavy || o.musket) { e.stag = big ? 0.5 : 0.4; e.act = null; }
  if (e.hp <= 0) {
    e.alive = false; e.act = 'dead'; e.actT = 0; e.deadT = 0; e.bar.grp.visible = false;
    const table = e.def.boss ? (e.def.boss === 'final' ? 'chest3' : 'chest2') : big ? 'brute' : 'foe';
    dropLoot(e.x, e.y, e.z, rollLoot(table, e.def.boss ? 4 : Math.random() < 0.6 ? 1 : 2), Math.random() < 0.45 ? 2 : e.type === 'tireur' ? 3 : 0);
    e.camp.left--;
    emit('kill', { type: e.type, e });
    if (e.camp.left <= 0) emit('cleared', { key: e.isl.id + ':' + e.camp.id });
    if (G.boss === e) G.boss = null;
  }
};

const shootAt = (e, dmg, speed = 36) => {
  const p = G.player, ox = e.x + Math.sin(e.yaw) * 0.9, oy = e.y + 1.4 * e.scale, oz = e.z + Math.cos(e.yaw) * 0.9;
  const tx = p.x, ty = p.y + 1.1, tz = p.z, d = Math.hypot(tx - ox, ty - oy, tz - oz) || 1;
  if (!bulletGeo) { bulletGeo = new THREE.SphereGeometry(0.1, 6, 4); bulletMat = new THREE.MeshBasicMaterial({ color: 0xffe08a }); }
  const mesh = new THREE.Mesh(bulletGeo, bulletMat);
  mesh.scale.set(1, 1, 5); G.scene.add(mesh);
  bullets.push({ x: ox, y: oy, z: oz, vx: ((tx - ox) / d) * speed, vy: ((ty - oy) / d) * speed, vz: ((tz - oz) / d) * speed, life: 2.2, dmg, sx: e.x, sz: e.z, mesh });
  puff('flash', ox, oy, oz, 1, { s: 0.45 }); puff('white', ox, oy, oz, 2, { s: 0.5 });
  sfxAt('musket', ox, oz, 90);
};

const startAct = (e, name, dur) => { e.act = name; e.actT = 0; e.actDur = dur; e.hitDone = false; };

const meleeCheck = (e, reach, arc, dmg) => {
  const p = G.player, d = Math.hypot(p.x - e.x, p.z - e.z);
  if (d > reach + p.radius || Math.abs(p.y - e.y) > 2 || Math.abs(wrap(Math.atan2(p.x - e.x, p.z - e.z) - e.yaw)) > arc) return;
  const r = damagePlayer(dmg, { x: e.x, z: e.z });
  if (r === 'parried') { e.stag = 1.3; e.act = null; e.poise = 0; e.rig.flash = 0.6; }
  else if (r === 'blocked') e.cd += 0.5;
};

// dans le fort, passer par la porte quand la cible est de l'autre côté du mur
const nav = (e, tx, tz) => {
  const isl = e.isl;
  if (!isl.fort) return [tx, tz];
  const k = isl.dock, loc = (x, z) => [(x - isl.x) * k.ux + (z - isl.z) * k.uz, (x - isl.x) * k.tx + (z - isl.z) * k.tz];
  const [ea, ec] = loc(e.x, e.z), [ta, tc] = loc(tx, tz);
  const ie = ea < 26 && Math.abs(ec) < 26 && ea > -26, it = ta < 26 && Math.abs(tc) < 26 && ta > -26;
  if (ie === it || (Math.abs(ec) < 2.3 && Math.abs(ea - 26) < 4.5)) return [tx, tz];
  const ga = ie ? 23 : 29;
  return [isl.x + ga * k.ux, isl.z + ga * k.uz];
};

const update = (e, dt) => {
  const p = G.player, def = e.def, t = G.time;
  if (!e.alive) {
    e.deadT += dt; e.actT += dt;
    animateRig(e.rig, { action: 'dead', u: e.actT / 1.0 }, dt);
    if (e.deadT > 2.4) e.rig.root.position.y -= dt * 0.5;
    return e.deadT > 4;
  }
  const active = p.mode === 'world' && !p.dead && G.mode === 'play';
  const dx = p.x - e.x, dz = p.z - e.z, d = Math.hypot(dx, dz), toP = Math.atan2(dx, dz), dHome = dist(e.x, e.z, e.home.x, e.home.z);
  let mx = 0, mz = 0, speed = 0, anim = null, u = 0, face = null;
  const go = (tx, tz, sp) => { const [nx, nz] = nav(e, tx, tz), a = Math.atan2(nx - e.x, nz - e.z); mx = Math.sin(a); mz = Math.cos(a); speed = sp; face = a; };
  e.cd -= dt; e.cd2 -= dt; e.t -= dt;
  const melee = e.type !== 'tireur';
  const boss = e.type === 'capitaine', big = e.type === 'brute' || e.type === 'boucher';

  if (e.stag > 0) { e.stag -= dt; anim = 'hit'; }
  else if (e.state === 'repos') {
    if (e.t <= 0 && !def.boss) { e.state = 'patrouille'; const a = Math.random() * 6.28, r = rnd(3, 9); e.wp = { x: e.home.x + Math.sin(a) * r, z: e.home.z + Math.cos(a) * r }; e.t = 6; }
    if (active && d < (def.boss === 'final' ? 11 : AGGRO) && Math.abs(p.y - e.y) < 5) e.state = 'poursuite';
  } else if (e.state === 'patrouille') {
    go(e.wp.x, e.wp.z, def.speed * 0.35);
    if (dist(e.x, e.z, e.wp.x, e.wp.z) < 1 || e.t <= 0) { e.state = 'repos'; e.t = rnd(2, 5); }
    if (active && d < AGGRO && Math.abs(p.y - e.y) < 5) e.state = 'poursuite';
  } else if (e.state === 'retour') {
    go(e.home.x, e.home.z, def.speed * 0.8);
    e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.25 * dt);
    if (G.boss === e) G.boss = null;
    if (dHome < 1.5) { e.state = 'repos'; e.t = rnd(1, 3); }
    if (active && d < AGGRO * 0.7 && dHome < LEASH * 0.6) e.state = 'poursuite';
  } else if (e.state === 'poursuite') {
    if (!active || dHome > LEASH) { e.state = 'retour'; e.act = null; }
    else {
      if (def.boss) G.boss = e;
      face = toP;
      const engaged = G.enemies.filter((m) => m.alive && m !== e && m.state === 'attaque' && m.type !== 'tireur').length;
      if (e.type === 'tireur') {
        if (d < 7) go(e.x - dx, e.z - dz, def.speed);
        else if (d > 16) go(p.x, p.z, def.speed);
        else { const a = toP + e.strafe * Math.PI / 2; mx = Math.sin(a); mz = Math.cos(a); speed = e.cd > 0.8 ? def.speed * 0.5 : 0; if (Math.random() < dt * 0.4) e.strafe *= -1; }
        face = toP;
        if (e.cd > 0.9) anim = 'reload';
        if (e.cd <= 0 && d < 24 && d > 3) { e.state = 'attaque'; startAct(e, 'aim', 1.15); }
      } else if (e.back > 0) { e.back -= dt; go(e.x - dx, e.z - dz, def.speed * 0.7); face = toP; }
      else {
        const reach = big ? 2.9 : boss ? 2.5 : 2.1;
        if (boss && e.phase < 2 && e.hp < e.maxHp * (e.phase === 0 ? 0.66 : 0.33)) { e.state = 'attaque'; startAct(e, 'shout', 1.3); }
        else if (boss && d > 8 && e.cd2 <= 0) { e.state = 'attaque'; startAct(e, 'aim', 0.75); e.cd2 = 5; }
        else if (d > reach) {
          if (engaged >= 2 && d < 6) { const a = toP + e.strafe * 1.9; mx = Math.sin(a); mz = Math.cos(a); speed = def.speed * 0.4; }
          else go(p.x, p.z, def.speed);
          face = toP;
        } else if (e.cd <= 0 && engaged < 2) {
          e.state = 'attaque'; e.combo = 0;
          if (big) { startAct(e, 'windup', e.type === 'boucher' ? 0.75 : 0.9); ring(e.x + Math.sin(toP) * 1.9, e.y, e.z + Math.cos(toP) * 1.9, 3.3, e.actDur); e.yaw = toP; }
          else startAct(e, 'a1', boss ? 0.6 : 0.78);
        }
      }
    }
  } else if (e.state === 'attaque') {
    e.actT += dt; u = e.actT / e.actDur; anim = e.act;
    if (e.act === 'aim') {
      e.yaw = dampAngle(e.yaw, toP, 10, dt);
      e.aimT -= dt;
      if (e.aimT <= 0 && u < 0.85) { e.aimT = 0.16; tracer(e.x + Math.sin(e.yaw) * 0.9, e.y + 1.4 * e.scale, e.z + Math.cos(e.yaw) * 0.9, p.x, p.y + 1.1, p.z, 0xff3a2a); }
      u = 0;
      if (e.actT >= e.actDur) { shootAt(e, boss ? 22 : e.dmg, boss ? 42 : 36); e.cd = boss ? 0.8 : rnd(2.2, 3); e.state = 'poursuite'; e.act = null; }
    } else if (e.act === 'windup') {
      if (e.actT >= e.actDur) startAct(e, 'heavy', 0.55);
      u = 0;
    } else if (e.act === 'heavy') {
      u = 0.5 + u * 0.5;
      if (!e.hitDone && e.actT > 0.1) {
        e.hitDone = true;
        const hx = e.x + Math.sin(e.yaw) * 1.9, hz = e.z + Math.cos(e.yaw) * 1.9;
        puff('dust', hx, e.y + 0.2, hz, 12, { s: 1.6 }); shake(0.35); sfxAt('wood', hx, hz, 60);
        if (Math.hypot(p.x - hx, p.z - hz) < 3.2 && Math.abs(p.y - e.y) < 2) {
          const r = damagePlayer(e.dmg, { x: e.x, z: e.z });
          if (r === 'parried') { e.stag = 1.5; e.act = null; }
        }
      }
      if (e.actT >= e.actDur + 0.7) { e.state = 'poursuite'; e.act = null; e.cd = rnd(1.2, 1.9); }
      if (e.actT >= e.actDur) anim = null;
    } else if (e.act === 'shout') {
      u = 0;
      if (!e.hitDone && e.actT > 0.5) {
        e.hitDone = true; e.phase++;
        emit('toast', { text: 'Le capitaine appelle des renforts !', key: 'renf' });
        sfxAt('warn', e.x, e.z, 80);
        const k = e.isl.dock, gx = e.isl.x + 20 * k.ux, gz = e.isl.z + 20 * k.uz;
        (e.phase === 1 ? ['bretteur', 'bretteur'] : ['bretteur', 'tireur']).forEach((ty, i) => { const m = spawn(ty, gx + (i ? 3 : -3) * k.tx, gz + (i ? 3 : -3) * k.tz, e.isl, e.camp, false); m.state = 'poursuite'; e.camp.left++; });
      }
      if (e.actT >= e.actDur) { e.state = 'poursuite'; e.act = null; e.cd = 0.5; }
    } else {
      // enchaînement au sabre
      if (u < 0.3) e.yaw = dampAngle(e.yaw, toP, 9, dt);
      if (u > 0.25 && u < 0.5) { mx = Math.sin(e.yaw); mz = Math.cos(e.yaw); speed = d > 1.6 ? 4.5 : 0; }
      if (!e.hitDone && u >= 0.4) {
        e.hitDone = true;
        slash(e.x, e.y + 1.2 * e.scale, e.z, e.yaw, e.act === 'a2' ? 0.25 : -0.25, 0xff8a70, 0.95 * e.scale);
        sfxAt('swing', e.x, e.z, 50);
        meleeCheck(e, boss ? 2.9 : 2.5, 1.0, e.act === 'a3' ? e.dmg * 1.6 : e.dmg);
      }
      if (u >= 1) {
        const chain = boss ? e.combo < 2 : e.combo < 1 && Math.random() < 0.55;
        if (chain && e.stag <= 0 && d < 4.5) { e.combo++; startAct(e, e.combo === 1 ? 'a2' : 'a3', boss ? 0.58 : 0.7); }
        else { e.state = 'poursuite'; e.act = null; e.cd = boss ? rnd(1.1, 1.6) : rnd(1.2, 2); e.back = boss ? 0 : rnd(0.4, 0.8); }
      }
    }
    if (!active) { e.state = 'retour'; e.act = null; }
  }

  // déplacement
  e.sp = damp(e.sp, speed, 10, dt);
  let nx = e.x + mx * e.sp * dt + e.kx * dt, nz = e.z + mz * e.sp * dt + e.kz * dt;
  e.kx = damp(e.kx, 0, 8, dt); e.kz = damp(e.kz, 0, 8, dt);
  const g = groundAt(nx, nz);
  if (g > 0.25 && g < e.y + 0.9) { e.x = nx; e.z = nz; }
  G.enemies.forEach((m) => {
    if (m === e || !m.alive) return;
    const ox = e.x - m.x, oz = e.z - m.z, od = Math.hypot(ox, oz), rr = e.radius + m.radius + 0.25;
    if (od < rr && od > 1e-4) { e.x += (ox / od) * (rr - od) * 0.5; e.z += (oz / od) * (rr - od) * 0.5; }
  });
  collideWorld(e, e.radius, e.isl);
  e.y = damp(e.y, groundAt(e.x, e.z), 14, dt);
  if (face !== null && e.stag <= 0 && e.state !== 'attaque') e.yaw = dampAngle(e.yaw, face, 9, dt);
  e.rig.root.position.set(e.x, e.y, e.z);
  e.rig.root.rotation.y = e.yaw;
  animateRig(e.rig, { speed: e.sp, action: anim, u }, dt);
  const show = e.hp < e.maxHp - 0.5 || e.state === 'poursuite' || e.state === 'attaque';
  e.bar.grp.visible = show && !def.boss;
  if (e.bar.grp.visible) { e.bar.grp.position.set(e.x, e.y + 2.3 * e.scale, e.z); e.bar.grp.quaternion.copy(G.camera.quaternion); e.bar.fg.scale.x = Math.max(0.001, 1.04 * clamp(e.hp / e.maxHp, 0, 1)); }
  return false;
};

export const updateEnemies = (dt) => {
  for (let i = G.enemies.length - 1; i >= 0; i--) if (update(G.enemies[i], dt)) { remove(G.enemies[i]); G.enemies.splice(i, 1); }
  const p = G.player;
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; b.life -= dt;
    b.mesh.position.set(b.x, b.y, b.z); b.mesh.lookAt(b.x + b.vx, b.y + b.vy, b.z + b.vz);
    let dead = b.life <= 0 || groundAt(b.x, b.z) > b.y;
    if (!dead && p.mode === 'world' && Math.hypot(b.x - p.x, b.z - p.z) < 0.6 && b.y > p.y && b.y < p.y + 1.9) {
      dead = damagePlayer(b.dmg, { x: b.sx, z: b.sz, ranged: true }) !== 'miss';
    }
    if (dead) { G.scene.remove(b.mesh); bullets.splice(i, 1); }
  }
};
