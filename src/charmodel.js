import { THREE } from './three.js';
import { G } from './state.js';
import { clamp, damp, lerp, TAU } from './util.js';
import { prim, builder, part, bake } from './geo.js';

// Un seul squelette bipède pour tout le monde (joueur, ennemis, boss) : seules les
// proportions, les couleurs et l'arme changent. Les animations sont procédurales.
// Repère : avant = +z, côté droit du personnage = -x.
const JOINTS = ['tor', 'head', 'aR', 'fR', 'aL', 'fL', 'lR', 'sR', 'lL', 'sL'];

export const makeRig = (o) => {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const bk = o.bulk || 1, skin = o.skin || 0xd9a37a, coat = o.coat, pants = o.pants, boot = 0x2a2019;
  const root = new THREE.Group(), piv = new THREE.Group(), hips = new THREE.Group();
  root.add(piv); piv.add(hips); piv.position.y = 0.95;
  const bone = (parent, x, y, z, build) => {
    const g = new THREE.Group();
    g.position.set(x, y, z); parent.add(g);
    const b = builder();
    build(b);
    if (b.length) { const m = new THREE.Mesh(bake(b), mat); m.castShadow = true; g.add(m); }
    return g;
  };
  bone(hips, 0, 0, 0, (b) => part(b, prim.box(), pants, [0, -0.02, 0], [0, 0, 0], [0.44 * bk, 0.24, 0.28 * bk]));
  const tor = bone(hips, 0, 0.06, 0, (b) => {
    part(b, prim.box(), coat, [0, 0.32, 0], [0, 0, 0], [0.52 * bk, 0.62, 0.3 * bk]);
    part(b, prim.box(), 0x3a2a1c, [0, 0.03, 0], [0, 0, 0], [0.54 * bk, 0.1, 0.32 * bk]);
    part(b, prim.box(), 0xc9a23f, [0, 0.03, 0.16 * bk], [0, 0, 0], [0.1, 0.1, 0.03]);
    if (o.hat === 'captain') { part(b, prim.box(), 0xc9a23f, [-0.3 * bk, 0.6, 0], [0, 0, 0], [0.2, 0.08, 0.3]); part(b, prim.box(), 0xc9a23f, [0.3 * bk, 0.6, 0], [0, 0, 0], [0.2, 0.08, 0.3]); }
  });
  const head = bone(tor, 0, 0.66, 0, (b) => {
    part(b, prim.box(), skin, [0, 0.15, 0], [0, 0, 0], [0.26, 0.28, 0.26]);
    part(b, prim.box(), 0x1a1410, [-0.06, 0.18, 0.131], [0, 0, 0], [0.04, 0.04, 0.02]);
    part(b, prim.box(), 0x1a1410, [0.06, 0.18, 0.131], [0, 0, 0], [0.04, 0.04, 0.02]);
    if (o.beard) part(b, prim.box(), o.beard, [0, 0.05, 0.1], [0, 0, 0], [0.24, 0.14, 0.1]);
    if (o.hat === 'tricorn' || o.hat === 'captain') {
      part(b, prim.cyl(3), o.hatCol, [0, 0.31, 0], [0, Math.PI, 0], [0.62, 0.07, 0.62]);
      part(b, prim.box(), o.hatCol, [0, 0.38, 0], [0, 0, 0], [0.26, 0.12, 0.26]);
      if (o.hat === 'captain') part(b, prim.box(), 0xc9a23f, [0, 0.33, 0.2], [0, 0, 0], [0.3, 0.04, 0.04]);
    } else if (o.hat === 'bandana') {
      part(b, prim.box(), o.hatCol, [0, 0.27, 0], [0, 0, 0], [0.28, 0.1, 0.28]);
      part(b, prim.box(), o.hatCol, [0.08, 0.2, -0.17], [0.4, 0, 0], [0.08, 0.2, 0.05]);
    }
  });
  const arm = (sx) => {
    const a = bone(tor, sx * 0.33 * bk, 0.56, 0, (b) => part(b, prim.box(), coat, [0, -0.14, 0], [0, 0, 0], [0.16 * bk, 0.36, 0.16 * bk]));
    const f = bone(a, 0, -0.32, 0, (b) => {
      part(b, prim.box(), o.bare ? skin : coat, [0, -0.13, 0], [0, 0, 0], [0.13 * bk, 0.28, 0.13 * bk]);
      part(b, prim.box(), skin, [0, -0.32, 0], [0, 0, 0], [0.11, 0.11, 0.11]);
    });
    const hand = new THREE.Group();
    hand.position.set(0, -0.33, 0); f.add(hand);
    return [a, f, hand];
  };
  const leg = (sx) => {
    const l = bone(hips, sx * 0.13 * bk, -0.05, 0, (b) => part(b, prim.box(), pants, [0, -0.2, 0], [0, 0, 0], [0.19 * bk, 0.45, 0.2 * bk]));
    const s = bone(l, 0, -0.42, 0, (b) => {
      part(b, prim.box(), boot, [0, -0.22, 0], [0, 0, 0], [0.16 * bk, 0.46, 0.18 * bk]);
      part(b, prim.box(), boot, [0, -0.43, 0.07], [0, 0, 0], [0.17 * bk, 0.1, 0.3]);
    });
    return [l, s];
  };
  const [aR, fR, handR] = arm(-1), [aL, fL, handL] = arm(1), [lR, sR] = leg(-1), [lL, sL] = leg(1);
  const tool = (parent, build, vis = true) => {
    const b = builder();
    build(b);
    const m = new THREE.Mesh(bake(b), mat);
    m.castShadow = true; m.visible = vis; parent.add(m);
    return m;
  };
  const steel = 0xd5dbe0;
  const rig = { root, piv, mat, j: { tor, head, aR, fR, aL, fL, lR, sR, lL, sL }, tgt: {}, phase: Math.random() * 6, pivY: 0, pivR: 0, flash: 0, o };
  if (o.weapon === 'saber' || o.weapon === 'player') {
    rig.saber = tool(handR, (b) => {
      part(b, prim.box(), steel, [0, 0.05, 0.6], [-0.08, 0, 0], [0.035, 0.07, 1.0]);
      part(b, prim.box(), 0xc9a23f, [0, 0, 0.09], [0, 0, 0], [0.22, 0.05, 0.05]);
      part(b, prim.box(), 0x3a2a1c, [0, 0, -0.02], [0, 0, 0], [0.05, 0.05, 0.2]);
    });
  }
  if (o.weapon === 'club') {
    rig.saber = tool(handR, (b) => {
      part(b, prim.cyl(6, 1.5), 0x4d3823, [0, 0, 0.55], [-Math.PI / 2, 0, 0], [0.16, 1.3, 0.16]);
      part(b, prim.box(), 0x77736b, [0, 0, 1.1], [0, 0, 0], [0.36, 0.36, 0.3]);
    });
  }
  const gunB = (b) => {
    part(b, prim.box(), 0x4d3823, [0, -0.25, 0], [0, 0, 0], [0.06, 1.0, 0.08]);
    part(b, prim.box(), 0x2b2f33, [0, -0.72, 0.01], [0, 0, 0], [0.04, 0.75, 0.04]);
    part(b, prim.box(), 0x4d3823, [0, 0.28, -0.06], [0.35, 0, 0], [0.06, 0.3, 0.12]);
  };
  if (o.weapon === 'musket') rig.gun = tool(handR, gunB);
  if (o.weapon === 'player') {
    rig.gun = tool(handR, gunB, false);
    rig.gunBack = tool(tor, (b) => part(b, prim.box(), 0x4d3823, [0.05, 0.35, -0.19], [0, 0, 0.6], [0.06, 1.1, 0.07]));
  }
  if (o.hat === 'captain') rig.pistol = tool(handL, (b) => { part(b, prim.box(), 0x2b2f33, [0, -0.2, 0], [0, 0, 0], [0.05, 0.42, 0.06]); part(b, prim.box(), 0x4d3823, [0, 0.02, -0.05], [0.5, 0, 0], [0.06, 0.18, 0.1]); });
  JOINTS.forEach((k) => { rig.tgt[k] = [0, 0, 0]; });
  root.scale.setScalar(o.scale || 1);
  return rig;
};

// poses d'action : A = armé, B = fin de frappe
const POSE = {
  a1: [{ aR: [-1.3, 0, -1.25], fR: [-0.5, 0, 0], tor: [0.05, -0.6, 0] }, { aR: [-1.35, 0, 0.8], fR: [-0.15, 0, 0], tor: [0.12, 0.65, 0] }],
  a2: [{ aR: [-1.3, 0, 0.85], fR: [-0.9, 0, 0], tor: [0.05, 0.55, 0] }, { aR: [-1.25, 0, -1.15], fR: [-0.1, 0, 0], tor: [0.12, -0.55, 0] }],
  a3: [{ aR: [-3.0, 0, -0.25], fR: [-0.7, 0, 0], tor: [-0.3, 0, 0] }, { aR: [-0.45, 0, 0.1], fR: [-0.1, 0, 0], tor: [0.45, 0, 0] }],
  heavy: [{ aR: [-3.1, 0, -0.2], fR: [-0.5, 0, 0], aL: [-3.0, 0, 0.3], fL: [-0.5, 0, 0], tor: [-0.38, 0, 0] }, { aR: [-0.4, 0, 0.2], fR: [0, 0, 0], aL: [-0.5, 0, -0.2], fL: [-0.2, 0, 0], tor: [0.6, 0, 0] }],
};
const HOLD = {
  parry: { aR: [-1.55, 0, 0.55], fR: [-1.0, 0, 0], aL: [-0.7, 0, -0.25], fL: [-0.9, 0, 0], tor: [0.05, 0.25, 0] },
  hit: { tor: [-0.4, 0.2, 0], head: [-0.3, 0, 0], aR: [-0.3, 0, -0.7], aL: [-0.3, 0, 0.7] },
  shout: { aR: [-2.7, 0, -0.6], aL: [-2.7, 0, 0.6], head: [-0.35, 0, 0], tor: [-0.2, 0, 0] },
  windup: { aR: [-3.1, 0, -0.2], fR: [-0.5, 0, 0], aL: [-3.0, 0, 0.3], fL: [-0.5, 0, 0], tor: [-0.38, 0, 0] },
  air: { lR: [-0.6, 0, 0], sR: [1.0, 0, 0], lL: [0.25, 0, 0], sL: [0.7, 0, 0], aR: [-0.5, 0, -0.5], aL: [-0.5, 0, 0.5] },
  roll: { lR: [-1.7, 0, 0], sR: [2.0, 0, 0], lL: [-1.7, 0, 0], sL: [2.0, 0, 0], aR: [-1.2, 0, 0.3], fR: [-1.6, 0, 0], aL: [-1.2, 0, -0.3], fL: [-1.6, 0, 0], tor: [0.7, 0, 0], head: [0.5, 0, 0] },
  dead: { aR: [-0.4, 0, -1.2], aL: [-0.4, 0, 1.2], lR: [-0.2, 0, -0.2], lL: [-0.1, 0, 0.25], head: [-0.2, 0.5, 0] },
};
const ease = (t) => t * t * (3 - 2 * t);

export const animateRig = (rig, a, dt) => {
  const T = rig.tgt, t = G.time;
  JOINTS.forEach((k) => { T[k][0] = 0; T[k][1] = 0; T[k][2] = 0; });
  const set = (pose, w = 1) => { for (const k in pose) { const p = pose[k], q = T[k]; q[0] = lerp(q[0], p[0], w); q[1] = lerp(q[1], p[1], w); q[2] = lerp(q[2], p[2], w); } };
  // locomotion de base
  const mv = clamp((a.speed || 0) / 5.5, 0, 1.15);
  rig.phase += (a.speed || 0) * dt * 1.75;
  const ph = rig.phase, sw = Math.sin(ph) * 0.9 * mv;
  T.lR[0] = -sw; T.lL[0] = sw;
  T.sR[0] = (0.2 + 0.9 * Math.max(0, Math.sin(ph + 2.2))) * mv; T.sL[0] = (0.2 + 0.9 * Math.max(0, Math.sin(ph + 2.2 + Math.PI))) * mv;
  T.aR[0] = sw * 0.7; T.aL[0] = -sw * 0.7; T.aR[2] = -0.08; T.aL[2] = 0.08;
  T.fR[0] = -0.15 - 0.5 * mv; T.fL[0] = -0.15 - 0.5 * mv;
  T.tor[0] = 0.14 * mv + Math.sin(t * 1.7 + rig.phase * 0.01) * 0.015; T.tor[1] = Math.sin(ph) * 0.12 * mv;
  let pivY = -Math.abs(Math.cos(ph)) * 0.05 * mv, pivR = 0, rate = 16, direct = false;
  const act = a.action, u = a.u || 0;
  if (a.air && !act) set(HOLD.air);
  if (POSE[act]) {
    const [A, B] = POSE[act], w = act === 'heavy' ? 0.5 : 0.3, e = act === 'heavy' ? 0.68 : 0.56;
    if (u < w) set(A, ease(Math.min(1, u / (w * 0.8))));
    else if (u < e) { set(A); set(B, ease((u - w) / (e - w))); }
    else set(B, 1 - ease((u - e) / (1 - e)) * 0.8);
    rate = 30;
  } else if (act === 'roll') { set(HOLD.roll); pivY = -0.45; pivR = u * TAU; direct = true; rate = 28; }
  else if (act === 'aim') {
    const p = a.aimPitch || 0;
    set({ aR: [-1.5 + p, 0, 0.1], fR: [0, 0, 0], aL: [-1.35 + p, 0, -0.6], fL: [-0.25, 0, 0], head: [p * 0.4, 0, 0] });
    if (u > 0) { T.aR[0] -= 0.35 * (1 - u); T.tor[0] -= 0.15 * (1 - u); }
    rate = 24;
  } else if (act === 'reload') set({ aR: [-0.7, 0, 0.2], fR: [-1.2, 0, 0], aL: [-0.95 + Math.sin(t * 9) * 0.28, 0, -0.4], fL: [-1.3, 0, 0] });
  else if (act === 'helm') { const r = a.rud || 0; set({ aR: [-1.25, 0, 0.22 + r * 0.35], aL: [-1.25, 0, -0.22 + r * 0.35], fR: [-0.35, 0, 0], fL: [-0.35, 0, 0], tor: [0.08, 0, r * 0.12] }); }
  else if (act === 'repair') { set({ lR: [-1.3, 0, 0], sR: [1.9, 0, 0], lL: [-0.3, 0, 0], sL: [1.5, 0, 0], aR: [-1.2 + Math.sin(t * 11) * 0.55, 0, 0], fR: [-0.8, 0, 0], aL: [-0.9, 0, -0.2], fL: [-0.6, 0, 0], tor: [0.4, 0, 0] }); pivY = -0.38; }
  else if (act === 'dead') { const e = ease(clamp(u * 1.6, 0, 1)); set(HOLD.dead, e); pivR = (-Math.PI / 2) * e; pivY = -0.72 * e; direct = true; }
  else if (HOLD[act]) { set(HOLD[act]); rate = 26; }
  const k = 1 - Math.exp(-rate * dt);
  JOINTS.forEach((n) => {
    const r = rig.j[n].rotation, q = T[n];
    r.x += (q[0] - r.x) * k; r.y += (q[1] - r.y) * k; r.z += (q[2] - r.z) * k;
  });
  rig.pivY = damp(rig.pivY, pivY, 18, dt);
  rig.piv.position.y = 0.95 + rig.pivY;
  rig.piv.rotation.x = direct ? pivR : damp(rig.piv.rotation.x, 0, 14, dt);
  if (rig.flash > 0) { rig.flash = Math.max(0, rig.flash - dt * 5); rig.mat.emissive.setScalar(rig.flash * 0.9); }
};

export const disposeRig = (rig) => {
  rig.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  rig.mat.dispose();
  if (rig.root.parent) rig.root.parent.remove(rig.root);
};
