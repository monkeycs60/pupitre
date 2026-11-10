import { THREE } from './three.js';
import { G } from './state.js';
import { TAU } from './util.js';
import { ISLANDS } from './config.js';

// Houle de Gerstner : la même liste de vagues sert au shader (rendu) et au calcul
// côté jeu (flottabilité des navires), pour que la coque suive vraiment l'eau.
export const WAVES = [
  [0.6, 54, 0.6, 0.17], [1.25, 33, 0.34, 0.15], [0.05, 20, 0.2, 0.13], [1.95, 11.5, 0.1, 0.1], [-0.5, 6.5, 0.05, 0.08],
].map(([a, L, A, s]) => {
  const k = TAU / L;
  return { dx: Math.sin(a), dz: Math.cos(a), k, w: Math.sqrt(9.81 * k) * 0.8, A, Q: s / (k * A), L };
});

export const SUN = new THREE.Vector3(-0.45, 0.62, -0.64).normalize();
export const COL = { zenith: 0x2f7fc9, horizon: 0xbfe3ee, deep: 0x0d4f7a, shallow: 0x2bc4b6, sun: 0xfff1cf };

// hauteur de l'eau en (x, z) au temps t
export const waveH = (x, z, t) => {
  let px = x, pz = z;
  for (let it = 0; it < 2; it++) {
    let ox = 0, oz = 0;
    for (let i = 0; i < WAVES.length; i++) {
      const w = WAVES[i], c = Math.cos(w.k * (w.dx * px + w.dz * pz) - w.w * t) * w.Q * w.A;
      ox += w.dx * c; oz += w.dz * c;
    }
    px = x - ox; pz = z - oz;
  }
  let y = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    y += w.A * Math.sin(w.k * (w.dx * px + w.dz * pz) - w.w * t);
  }
  return y;
};

const f = (n) => (Number.isInteger(n) ? n + '.0' : String(n));
const waveGLSL = WAVES.map((w, i) => `
  { float fade = ${w.L < 21 ? `1.0 - smoothstep(${f(w.L * 9)}, ${f(w.L * 22)}, dc)` : '1.0'};
    vec2 d = vec2(${f(w.dx)}, ${f(w.dz)});
    float ph = ${f(w.k)} * dot(d, p.xz) - ${f(w.w)} * uTime;
    float c = cos(ph), s = sin(ph), A = ${f(w.A)} * fade;
    disp.xz += d * (${f(w.Q)} * A * c); disp.y += A * s;
    nrm.xz -= d * (${f(w.k)} * A * c); nrm.y -= ${f(w.Q * w.k)} * A * s;
    crest += ${f(w.Q * w.k)} * A * s; }`).join('');

const NOISE = `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ return vn(p)*0.55 + vn(p*2.1+7.3)*0.3 + vn(p*4.3+3.1)*0.15; }`;

let ocean, sky;

export const initOcean = () => {
  // grille polaire : dense près du joueur, large jusqu'à l'horizon
  const rings = G.quality > 1 ? 120 : 90, segs = G.quality > 1 ? 168 : 128;
  const pos = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const r = i === 0 ? 0 : 0.85 * i + 3600 * Math.pow(i / rings, 5.5);
    for (let j = 0; j < segs; j++) { const a = (j / segs) * TAU; pos.push(Math.sin(a) * r, 0, Math.cos(a) * r); }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * segs + j, b = i * segs + ((j + 1) % segs), c = a + segs, d = b + segs;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const isl = ISLANDS.map((s) => new THREE.Vector4(s.x, s.z, s.r, 0));
  const islP = ISLANDS.map((s) => new THREE.Vector2(s.p1, s.p2));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uSun: { value: SUN },
      uDeep: { value: new THREE.Color(COL.deep) }, uShallow: { value: new THREE.Color(COL.shallow) },
      uHorizon: { value: new THREE.Color(COL.horizon) }, uZenith: { value: new THREE.Color(COL.zenith) },
      uSunCol: { value: new THREE.Color(COL.sun) }, uIsl: { value: isl }, uIslP: { value: islP },
    },
    vertexShader: `
      uniform float uTime;
      varying vec3 vW; varying vec3 vN; varying float vCrest;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 p = wp.xyz; float dc = length(position.xz);
        vec3 disp = vec3(0.0); vec3 nrm = vec3(0.0, 1.0, 0.0); float crest = 0.0;
        ${waveGLSL}
        p += disp; vW = p; vN = nrm; vCrest = crest;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      precision highp float;
      uniform float uTime; uniform vec3 uSun, uDeep, uShallow, uHorizon, uZenith, uSunCol;
      uniform vec4 uIsl[${ISLANDS.length}]; uniform vec2 uIslP[${ISLANDS.length}];
      varying vec3 vW; varying vec3 vN; varying float vCrest;
      ${NOISE}
      void main(){
        vec3 V = cameraPosition - vW; float dist = length(V); V /= dist;
        // petites rides : normale de détail qui défile
        vec2 q = vW.xz * 0.35;
        float n1 = fbm(q + vec2(uTime*0.22, uTime*0.13)), n2 = fbm(q*1.7 - vec2(uTime*0.17, -uTime*0.2));
        float e = 0.35;
        float n1x = fbm(q + vec2(e,0.0) + vec2(uTime*0.22, uTime*0.13)), n1z = fbm(q + vec2(0.0,e) + vec2(uTime*0.22, uTime*0.13));
        float det = 1.0 - smoothstep(60.0, 420.0, dist);
        vec3 N = normalize(vN + vec3(-(n1x-n1), 0.0, -(n1z-n1)) * 1.6 * det);
        // rivage : même forme de côte que le terrain
        float shore = 0.0, line = 0.0;
        for (int i = 0; i < ${ISLANDS.length}; i++) {
          vec2 d = vW.xz - uIsl[i].xy; float l = length(d);
          if (l < uIsl[i].z * 1.9) {
            float ang = atan(d.x, d.y);
            float R = uIsl[i].z * (1.0 + 0.10*sin(3.0*ang + uIslP[i].x) + 0.06*sin(5.0*ang + uIslP[i].y));
            float s = 1.0 - l / R;
            shore = max(shore, smoothstep(-0.42, 0.0, s));
            float band = sin(s*R*0.55 + uTime*1.3 + n2*3.0);
            line = max(line, smoothstep(-0.07, 0.0, s) * (0.45 + 0.55*smoothstep(0.2, 0.9, band)));
          }
        }
        vec3 water = mix(uDeep, uShallow, shore*0.85);
        water += vec3(0.02, 0.16, 0.14) * smoothstep(0.0, 0.45, vCrest); // lumière à travers la crête
        float fres = 0.03 + 0.9 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
        vec3 R = reflect(-V, N); R.y = abs(R.y);
        vec3 skyc = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.6));
        vec3 col = mix(water, skyc, fres * (1.0 - shore*0.4));
        float sp = pow(max(dot(R, uSun), 0.0), 220.0);
        col += uSunCol * sp * 2.2;
        col += uSunCol * pow(max(dot(R, uSun), 0.0), 18.0) * 0.12;
        float foam = smoothstep(0.34, 0.6, vCrest + (n2 - 0.5)*0.42) * det;
        foam = max(foam, line * (0.6 + 0.4*n1));
        col = mix(col, vec3(0.96, 0.98, 0.97), clamp(foam, 0.0, 1.0) * 0.9);
        col = mix(col, uHorizon, smoothstep(500.0, 3000.0, dist));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  ocean = new THREE.Mesh(g, mat);
  ocean.frustumCulled = false;
  ocean.renderOrder = -1;
  G.scene.add(ocean);

  // ciel : dégradé, soleil, nuages procéduraux
  const sg = new THREE.SphereGeometry(4200, 32, 16);
  const sm = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 }, uSun: { value: SUN }, uHorizon: { value: new THREE.Color(COL.horizon) }, uZenith: { value: new THREE.Color(COL.zenith) }, uSunCol: { value: new THREE.Color(COL.sun) } },
    vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform float uTime; uniform vec3 uSun, uHorizon, uZenith, uSunCol; varying vec3 vD;
      ${NOISE}
      void main(){
        vec3 d = normalize(vD); float t = max(d.y, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(t, 0.5));
        float sd = max(dot(d, uSun), 0.0);
        col += uSunCol * (pow(sd, 900.0) * 6.0 + pow(sd, 10.0) * 0.22);
        vec2 uv = d.xz / (d.y + 0.16) * 1.3 + vec2(uTime * 0.006, uTime * 0.002);
        float c = smoothstep(0.5, 0.78, fbm(uv) * 0.75 + fbm(uv * 2.7 + 4.0) * 0.3);
        c *= smoothstep(0.02, 0.3, d.y);
        vec3 cc = mix(vec3(0.78, 0.84, 0.9), vec3(1.0), smoothstep(0.3, 1.0, fbm(uv * 1.9 + 9.0) + sd * 0.3));
        col = mix(col, cc, c * 0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  sky = new THREE.Mesh(sg, sm);
  sky.frustumCulled = false;
  sky.renderOrder = -2;
  G.scene.add(sky);
};

export const updateOcean = (fx, fz) => {
  ocean.position.set(fx, 0, fz);
  ocean.material.uniforms.uTime.value = G.time;
  sky.position.set(G.camera.position.x, 0, G.camera.position.z);
  sky.material.uniforms.uTime.value = G.time;
};
