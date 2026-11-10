import { THREE } from './three.js';
// Petit constructeur de maillages : on empile des pièces colorées puis on les fusionne
// en une seule géométrie (un seul appel de dessin par objet).
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const cache = {};
const memo = (k, f) => cache[k] || (cache[k] = f());
export const prim = {
  box: () => memo('box', () => new THREE.BoxGeometry(1, 1, 1)),
  cyl: (n = 8, top = 1) => memo('cyl' + n + '_' + top, () => new THREE.CylinderGeometry(0.5 * top, 0.5, 1, n)),
  cone: (n = 8) => memo('cone' + n, () => new THREE.ConeGeometry(0.5, 1, n)),
  sph: (n = 7) => memo('sph' + n, () => new THREE.SphereGeometry(0.5, n, Math.max(4, n - 2))),
  plane: () => memo('plane', () => new THREE.PlaneGeometry(1, 1)),
};
export const builder = () => [];
export const part = (b, geom, color, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) => {
  b.push({ geom, color, pos, rot, scl });
  return b;
};
// géométrie brute : positions (triangles) et couleurs par sommet déjà en linéaire
export const raw = (b, positions, colors) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  b.push({ geom: g, color: null, pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1] });
  return b;
};
export const lin = (hex) => { _c.set(hex); return [_c.r, _c.g, _c.b]; };
export const bake = (b) => {
  let n = 0;
  const gs = b.map((p) => {
    const g = p.geom.index ? p.geom.toNonIndexed() : p.geom.clone();
    _e.set(p.rot[0], p.rot[1], p.rot[2], p.rot[3] || 'XYZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(p.pos[0], p.pos[1], p.pos[2]), _q, _s.set(p.scl[0], p.scl[1], p.scl[2]));
    g.applyMatrix4(_m);
    n += g.attributes.position.count;
    return g;
  });
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  gs.forEach((g, i) => {
    const a = g.attributes.position.array, cnt = a.length / 3, p = b[i];
    pos.set(a, o * 3);
    if (p.color === null && g.attributes.color) col.set(g.attributes.color.array, o * 3);
    else {
      _c.set(p.color);
      for (let k = 0; k < cnt; k++) { col[(o + k) * 3] = _c.r; col[(o + k) * 3 + 1] = _c.g; col[(o + k) * 3 + 2] = _c.b; }
    }
    o += cnt;
    g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeVertexNormals();
  return out;
};
export const MAT = {};
export const initMats = () => {
  MAT.vc = new THREE.MeshLambertMaterial({ vertexColors: true });
  MAT.vc2 = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
};
export const mesh = (b, mat, shadow = 3) => {
  const m = new THREE.Mesh(bake(b), mat || MAT.vc);
  m.castShadow = !!(shadow & 1);
  m.receiveShadow = !!(shadow & 2);
  return m;
};
