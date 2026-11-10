import { THREE } from './three.js';
import { G } from './state.js';
import { rnd, clamp } from './util.js';
import { waveH } from './ocean.js';

const N = 900;
const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N);
const life = new Float32Array(N), max = new Float32Array(N), size = new Float32Array(N), grow = new Float32Array(N);
const grav = new Float32Array(N), drag = new Float32Array(N), alpha = new Float32Array(N), wave = new Uint8Array(N);
const posA = new Float32Array(N * 3), colA = new Float32Array(N * 4), sizeA = new Float32Array(N);
let cursor = 0, points, geo;

const K = {
  smoke: { c: [0.2, 0.2, 0.22], a: 0.55, s: [1.2, 2.2], g: 1.6, l: [1.4, 2.6], sp: 1.1, up: 1.8, gr: -0.4, dr: 1.2 },
  white: { c: [0.92, 0.92, 0.88], a: 0.6, s: [1.0, 1.9], g: 2.2, l: [0.9, 1.8], sp: 1.6, up: 0.8, gr: -0.3, dr: 1.6 },
  fire: { c: [1, 0.5, 0.1], a: 0.9, s: [0.7, 1.3], g: -0.8, l: [0.35, 0.7], sp: 0.8, up: 2.4, gr: -1, dr: 1 },
  splash: { c: [0.95, 0.98, 1], a: 0.9, s: [0.3, 0.7], g: 0.3, l: [0.6, 1.1], sp: 3.2, up: 7, gr: 15, dr: 0.3 },
  spark: { c: [1, 0.85, 0.4], a: 1, s: [0.1, 0.2], g: 0, l: [0.2, 0.45], sp: 6, up: 2, gr: 9, dr: 1 },
  wood: { c: [0.36, 0.24, 0.13], a: 1, s: [0.2, 0.45], g: 0, l: [0.7, 1.3], sp: 5, up: 5, gr: 15, dr: 0.4 },
  hit: { c: [1, 0.28, 0.18], a: 1, s: [0.14, 0.3], g: 0, l: [0.25, 0.5], sp: 5, up: 2.5, gr: 11, dr: 1.5 },
  foam: { c: [1, 1, 1], a: 0.5, s: [0.8, 1.6], g: 1.0, l: [1.8, 3.2], sp: 0.7, up: 0, gr: 0, dr: 1, w: 1 },
  dust: { c: [0.85, 0.78, 0.6], a: 0.5, s: [0.5, 0.9], g: 1.2, l: [0.4, 0.8], sp: 1.5, up: 0.8, gr: 0, dr: 2 },
  flash: { c: [1, 0.9, 0.6], a: 1, s: [2.4, 3.2], g: -10, l: [0.09, 0.13], sp: 0, up: 0, gr: 0, dr: 0 },
  gold: { c: [1, 0.85, 0.3], a: 1, s: [0.12, 0.22], g: 0, l: [0.5, 0.9], sp: 2, up: 4, gr: 9, dr: 0.5 },
};

export const puff = (kind, x, y, z, n = 1, o = {}) => {
  const k = K[kind], sc = o.s || 1;
  for (let j = 0; j < n; j++) {
    const i = cursor; cursor = (cursor + 1) % N;
    const a = Math.random() * 6.283, r = Math.random() * k.sp * sc;
    px[i] = x + (Math.random() - 0.5) * (o.spread || 0); py[i] = y; pz[i] = z + (Math.random() - 0.5) * (o.spread || 0);
    vx[i] = Math.cos(a) * r + (o.vx || 0); vz[i] = Math.sin(a) * r + (o.vz || 0); vy[i] = k.up * (0.5 + Math.random() * 0.7) * sc + (o.vy || 0);
    max[i] = life[i] = rnd(k.l[0], k.l[1]); size[i] = rnd(k.s[0], k.s[1]) * sc; grow[i] = k.g * sc;
    grav[i] = k.gr; drag[i] = k.dr; alpha[i] = k.a; wave[i] = k.w || 0;
    colA[i * 4] = k.c[0]; colA[i * 4 + 1] = k.c[1]; colA[i * 4 + 2] = k.c[2];
  }
};

// objets recyclés : boulets, traînées de tir, arcs de sabre, anneaux d'annonce
const pools = { ball: [], tracer: [], slash: [], ring: [] };
const active = [];
const nums = [];
let ballGeo, ballMat;

export const initFx = () => {
  geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posA, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aCol', new THREE.BufferAttribute(colA, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizeA, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uScale: { value: 500 } },
    vertexShader: `attribute vec4 aCol; attribute float aSize; uniform float uScale; varying vec4 vC;
      void main(){ vC = aCol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec4 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.28, d) * vC.a; if (a < 0.01) discard; gl_FragColor = vec4(vC.rgb, a);
      #include <colorspace_fragment>
    }`,
  });
  points = new THREE.Points(geo, mat);
  points.frustumCulled = false; points.renderOrder = 5;
  G.scene.add(points);
  ballGeo = new THREE.SphereGeometry(0.3, 7, 5);
  ballMat = new THREE.MeshBasicMaterial({ color: 0x15171a });
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 1), new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true }));
    m.visible = false; G.scene.add(m); pools.tracer.push(m);
  }
  const sg = new THREE.RingGeometry(1.0, 2.6, 14, 1, -1.2, 2.4);
  sg.rotateX(-Math.PI / 2); sg.rotateY(-Math.PI / 2);
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.visible = false; G.scene.add(m); pools.slash.push(m);
  }
  const rg = new THREE.RingGeometry(0.86, 1, 36);
  rg.rotateX(-Math.PI / 2);
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xff4030, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    m.visible = false; G.scene.add(m); pools.ring.push(m);
  }
};

export const getBall = () => {
  const m = pools.ball.pop() || new THREE.Mesh(ballGeo, ballMat);
  if (!m.parent) G.scene.add(m);
  m.visible = true;
  return m;
};
export const freeBall = (m) => { m.visible = false; pools.ball.push(m); };

const take = (pool) => pools[pool].find((m) => !m.visible) || pools[pool][0];
export const tracer = (x0, y0, z0, x1, y1, z1, color = 0xfff0b0) => {
  const m = take('tracer');
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.lookAt(x1, y1, z1);
  m.scale.set(1, 1, Math.hypot(x1 - x0, y1 - y0, z1 - z0));
  m.material.color.set(color); m.material.opacity = 1; m.visible = true;
  active.push({ m, t: 0, dur: 0.14, kind: 'fade' });
};
export const slash = (x, y, z, yaw, tilt = 0, color = 0xffffff, sc = 1) => {
  const m = take('slash');
  m.position.set(x, y, z); m.rotation.set(0, yaw, tilt, 'YXZ'); m.scale.setScalar(sc);
  m.material.color.set(color); m.material.opacity = 0.85; m.visible = true;
  active.push({ m, t: 0, dur: 0.18, kind: 'slash', sc });
};
export const ring = (x, y, z, r, dur, color = 0xff4030) => {
  const m = take('ring');
  m.position.set(x, y + 0.08, z); m.scale.setScalar(r);
  m.material.color.set(color); m.material.opacity = 0.9; m.visible = true;
  active.push({ m, t: 0, dur, kind: 'ring', r });
};
export const shake = (a) => { G.shake = Math.max(G.shake, a); };

const _v = new THREE.Vector3();
export const num = (x, y, z, text, cls = '') => {
  if (!G.numsEl) return;
  let n = nums.find((q) => q.t <= 0);
  if (!n) {
    if (nums.length >= 16) n = nums[0];
    else { n = { el: document.createElement('span'), t: 0 }; G.numsEl.appendChild(n.el); nums.push(n); }
  }
  n.x = x; n.y = y; n.z = z; n.t = 0.9; n.el.textContent = text; n.el.className = 'num ' + cls; n.el.hidden = false;
};

export const updateFx = (dt) => {
  const t = G.time;
  for (let i = 0; i < N; i++) {
    if (life[i] <= 0) { sizeA[i] = 0; continue; }
    life[i] -= dt;
    const d = Math.max(0, 1 - drag[i] * dt);
    vx[i] *= d; vz[i] *= d; vy[i] = vy[i] * d - grav[i] * dt;
    px[i] += vx[i] * dt; pz[i] += vz[i] * dt; py[i] += vy[i] * dt;
    if (wave[i]) py[i] = waveH(px[i], pz[i], t) + 0.12;
    size[i] = Math.max(0.01, size[i] + grow[i] * dt);
    const f = clamp(life[i] / max[i], 0, 1);
    posA[i * 3] = px[i]; posA[i * 3 + 1] = py[i]; posA[i * 3 + 2] = pz[i];
    colA[i * 4 + 3] = alpha[i] * Math.min(1, f * 2.2);
    sizeA[i] = life[i] > 0 ? size[i] : 0;
  }
  geo.attributes.position.needsUpdate = true; geo.attributes.aCol.needsUpdate = true; geo.attributes.aSize.needsUpdate = true;
  points.material.uniforms.uScale.value = G.renderer.domElement.height / (2 * Math.tan((G.camera.fov * Math.PI) / 360));
  for (let i = active.length - 1; i >= 0; i--) {
    const a = active[i];
    a.t += dt;
    const u = a.t / a.dur;
    if (u >= 1) { a.m.visible = false; active.splice(i, 1); continue; }
    if (a.kind === 'slash') { a.m.material.opacity = 0.85 * (1 - u); a.m.scale.setScalar(a.sc * (0.85 + u * 0.3)); }
    else if (a.kind === 'ring') { a.m.material.opacity = 0.35 + 0.6 * u; a.m.scale.setScalar(a.r * (0.25 + 0.75 * u)); }
    else a.m.material.opacity = 1 - u;
  }
  const w = window.innerWidth, h = window.innerHeight;
  nums.forEach((n) => {
    if (n.t <= 0) return;
    n.t -= dt; n.y += dt * 1.4;
    _v.set(n.x, n.y, n.z).project(G.camera);
    if (n.t <= 0 || _v.z > 1) { n.el.hidden = true; n.t = 0; return; }
    n.el.style.transform = `translate(${((_v.x + 1) / 2) * w}px, ${((1 - _v.y) / 2) * h}px) translate(-50%,-50%)`;
    n.el.style.opacity = Math.min(1, n.t * 3);
  });
};
