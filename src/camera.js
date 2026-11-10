import { THREE } from './three.js';
import { G, on } from './state.js';
import { clamp, damp, dampAngle, lerp, wrap } from './util.js';
import { groundAt } from './world.js';
import { waveH } from './ocean.js';
import { inputState } from './input.js';

const _v = new THREE.Vector3();
const aimTarget = () => {
  const p = G.player, c = G.cam;
  let best = null, bs = 99;
  G.enemies.forEach((e) => {
    if (!e.alive) return;
    const d = Math.hypot(e.x - p.x, e.z - p.z), a = Math.abs(wrap(Math.atan2(e.x - p.x, e.z - p.z) - c.yaw));
    if (d < 45 && a < 1.3 && d * (0.4 + a) < bs) { bs = d * (0.4 + a); best = e; }
  });
  return best;
};
export const initCamera = () => {
  // au tactile ou à la manette, la visée s'accroche à l'ennemi le plus proche
  on('aimStart', () => {
    if (!G.isTouch && !inputState.usedPad) return;
    const e = aimTarget(), p = G.player, c = G.cam;
    if (e) { c.yaw = Math.atan2(e.x - p.x, e.z - p.z); c.pitch = Math.atan2(p.y + 1.6 - (e.y + 1.1 * e.scale), Math.hypot(e.x - p.x, e.z - p.z)); }
  });
};

export const updateCamera = (dt) => {
  const c = G.cam, p = G.player, s = G.ship, inp = G.input, cam = G.camera;
  const helm = p.mode === 'helm', title = G.mode === 'title', aspect = cam.aspect;
  if (G.mode === 'play') {
    if (helm) c.rel = wrap(c.rel - inp.lookX); else c.yaw = wrap(c.yaw - inp.lookX);
    c.pitch = clamp(c.pitch + inp.lookY, helm ? 0.06 : -0.5, 1.25);
    if (p.aiming && (G.isTouch || inputState.usedPad) && !inp.dragging) {
      const e = aimTarget();
      if (e) { c.yaw = dampAngle(c.yaw, Math.atan2(e.x - p.x, e.z - p.z), 7, dt); c.pitch = damp(c.pitch, Math.atan2(p.y + 1.6 - (e.y + 1.1 * e.scale), Math.hypot(e.x - p.x, e.z - p.z)), 7, dt); }
    }
  }
  // sans souris capturée (tactile, cadre intégré), la caméra revient doucement derrière le pirate en marche
  c.idle = Math.abs(inp.lookX) + Math.abs(inp.lookY) > 0.0005 || inp.dragging ? 0 : (c.idle || 0) + dt;
  if (G.mode === 'play' && !helm && !p.aiming && !inputState.locked && c.idle > 1.1 && p.speed > 2.5 && !p.act) {
    const diff = wrap(p.yaw - c.yaw);
    if (Math.abs(diff) < 2.3) c.yaw = wrap(c.yaw + diff * Math.min(1, dt * 1.5));
  }
  if (title) { c.yaw = wrap(c.yaw + dt * 0.07); c.pitch = 0.22; }
  // sur le pont, la caméra reste au-dessus du pavois
  if (p.mode === 'deck' && !p.aiming && c.pitch < 0.42 && G.mode === 'play') c.pitch = damp(c.pitch, 0.42, 4, dt);
  if (helm) c.yaw = wrap(s.th + c.rel);
  c.aimBlend = damp(c.aimBlend, p.aiming ? 1 : 0, 12, dt);
  const wide = aspect < 1 ? 1.3 : 1;
  let distT, px, py, pz;
  if (helm || title) {
    distT = (title ? 40 : 25 + s.speed * 0.55) * wide;
    px = s.x; py = s.heave * 0.4 + 5.5; pz = s.z;
  } else {
    distT = lerp(G.isTouch ? 6.2 : 5.6, 3.1, c.aimBlend) * (aspect < 1 ? 1.15 : 1);
    p.rig.root.getWorldPosition(_v);
    px = _v.x; py = _v.y + lerp(1.55, 1.78, c.aimBlend); pz = _v.z;
  }
  const snap = Math.hypot(px - c.tx, pz - c.tz) > 60;
  c.dist = damp(c.dist, distT, 4.5, dt);
  c.tx = snap ? px : damp(c.tx, px, 16, dt); c.ty = snap ? py : damp(c.ty, py, 12, dt); c.tz = snap ? pz : damp(c.tz, pz, 16, dt);
  const cp = Math.cos(c.pitch), dx = Math.sin(c.yaw) * cp, dy = -Math.sin(c.pitch), dz = Math.cos(c.yaw) * cp;
  const rx = -Math.cos(c.yaw), rz = Math.sin(c.yaw), sh = 0.95 * c.aimBlend;
  let x = c.tx - dx * c.dist + rx * sh, y = c.ty - dy * c.dist, z = c.tz - dz * c.dist + rz * sh;
  y = Math.max(y, groundAt(x, z) + 0.5, waveH(x, z, G.time) + 0.7);
  if (G.shake > 0) {
    const k = G.shake * G.shake * 1.6;
    x += (Math.random() - 0.5) * k; y += (Math.random() - 0.5) * k; z += (Math.random() - 0.5) * k;
    G.shake = Math.max(0, G.shake - dt * 1.8);
  }
  cam.position.set(x, y, z);
  cam.lookAt(x + dx, y + dy, z + dz);
  // champ de vision : on garde au moins 62° à l'horizontale, même en portrait
  const base = lerp(helm ? 62 : 60, 46, c.aimBlend);
  const fov = aspect >= 1.2 ? base : clamp((2 * Math.atan(Math.tan((base * 1.25 * Math.PI) / 360) / Math.max(aspect, 0.4)) * 180) / Math.PI, base, 100);
  if (Math.abs(fov - cam.fov) > 0.05) { cam.fov = damp(cam.fov, fov, 8, dt); cam.updateProjectionMatrix(); }
};
