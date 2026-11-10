import { THREE } from './three.js';
import { G, on, emit } from './state.js';
import { dist } from './util.js';
import { initMats } from './geo.js';
import { initOcean, updateOcean, SUN, COL } from './ocean.js';
import { initWorld, updateWorld, islands, fires, resetSortieWorld } from './world.js';
import { createShip, placeAtDock, applyUpgrades, spawnFleet, updateShips, fullRepair, nearDock } from './ship.js';
import { createPlayer, updatePlayer, toDeck, toWorld } from './player.js';
import { updateEnemies, activateIsland, deactivateIsland } from './enemies.js';
import { initFx, updateFx, puff } from './fx.js';
import { initInput, pollInput, requestLock } from './input.js';
import { initCamera, updateCamera } from './camera.js';
import { initHud, updateHud, openPanel, showHud } from './hud.js';
import { setAmbience, setSound } from './audio.js';
import * as P from './progression.js';

let renderer, scene, camera, sun, app, last = 0, prScale = 1, acc = 0, accN = 0, shadowR = 0, started = false;
const PR_CAP = [1, 1.5, 2];

const resize = () => {
  const w = app.clientWidth || window.innerWidth, h = app.clientHeight || window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PR_CAP[G.quality]) * prScale);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
};
const applyQuality = () => {
  G.quality = G.save.opts.quality;
  sun.castShadow = G.quality > 0;
  const sz = G.quality > 1 ? 2048 : 1024;
  if (sun.shadow.mapSize.x !== sz) { sun.shadow.mapSize.set(sz, sz); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
  prScale = 1;
  resize();
};

const placeStart = () => {
  const port = islands[0], f = port.flats[0], k = port.dock, p = G.player;
  toWorld(p, f.x + k.ux * 5, f.z + k.uz * 5, k.a + Math.PI);
  G.cam.yaw = k.a + Math.PI; G.cam.pitch = 0.22; G.cam.dist = 6; G.cam.tx = p.x; G.cam.tz = p.z; G.cam.ty = p.y + 1.5;
};
const startGame = ({ fresh }) => {
  const s = G.ship, p = G.player;
  if (fresh || !started) {
    if (fresh) { const o = G.save.opts; P.eraseSave(); G.save = P.newSave(); G.save.opts = o; }
    if (!G.save.bounty.offers.length) P.refreshOffers();
    if (G.activeIsland) { deactivateIsland(G.activeIsland); G.activeIsland = null; }
    s.alive = true; s.sink = 0; s.group.visible = true;
    fullRepair(s); applyUpgrades(s, G.save.up); placeAtDock(s, islands[0]);
    P.startSortie(); P.applyLevel();
    p.hp = p.maxHp; p.st = p.maxSt; p.ammo = fresh ? 8 : G.save.ammo; p.reloadT = 0;
    resetSortieWorld(); spawnFleet(); placeStart();
    emit('banner', { title: 'Port-Liberté', sub: fresh ? 'Choisis une prime au tableau, puis embarque et prends la barre' : 'Bon retour, capitaine' });
  }
  started = true; G.hasSave = true;
  G.mode = 'play';
  showHud(true);
  setSound(G.save.opts.sound);
  requestLock();
  try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {}); } catch (e) { /* veille non gérée */ }
};

// active les ennemis de l'île proche ; ils réapparaissent quand on l'a quittée
const updateIslands = () => {
  const p = G.player, cur = G.activeIsland;
  if (cur && dist(p.x, p.z, cur.x, cur.z) > cur.r * 1.2 + 220) { deactivateIsland(cur); G.activeIsland = null; }
  if (!G.activeIsland) {
    const isl = islands.find((i) => dist(p.x, p.z, i.x, i.z) < i.r * 1.2 + 150);
    if (isl) { G.activeIsland = isl; activateIsland(isl); if (p.mode === 'helm') emit('banner', { title: isl.name, sub: isl.sub }); }
  }
  const a = G.activeIsland;
  if (a && Math.random() < G.dt * 14) fires.forEach((f) => { if (f.isl === a) { puff('fire', f.x, f.y, f.z, 1, { s: 0.7 }); if (Math.random() < 0.3) puff('smoke', f.x, f.y + 0.8, f.z, 1, { s: 0.5 }); } });
};

let hintT = 0;
const hints = (dt) => {
  const p = G.player, s = G.ship;
  hintT -= dt;
  if (hintT > 0) return;
  hintT = 1;
  if (p.mode === 'helm' && s.speed < 11 && G.sortie.time > 20 && nearDock(s)) emit('toast', { text: 'Ponton proche : lâche la barre pour accoster', key: 'dock' });
  if (p.mode === 'helm' && s.sail === 0 && !G.save.hints.sail) { G.save.hints.sail = 1; emit('toast', { text: G.isTouch ? 'Bouton ▲ : hisser les voiles' : 'Avance : hisser les voiles. Recule : les carguer.' }); }
  if (p.aboard && !s.helm && !s.moored && !G.save.hints.anchor) { G.save.hints.anchor = 1; emit('toast', { text: 'Barre lâchée : le navire s’arrête. Colmate les zones abîmées à pied.' }); }
};

const step = (dt) => {
  P.updateTimers(dt);
  updateShips(dt);
  updatePlayer(dt);
  updateEnemies(dt);
  updateWorld(dt);
  P.updateProgression(dt);
  updateIslands();
  hints(dt);
};

const frame = (now) => {
  requestAnimationFrame(frame);
  const rdt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;
  let dt = rdt;
  if (G.mode === 'play') {
    if (G.hitStop > 0) { G.hitStop -= rdt; dt *= 0.06; }
    G.dt = dt; G.time += dt;
    pollInput();
    step(dt);
    updateCamera(rdt);
    updateHud();
    setAmbience(Math.min(1, G.ship.speed / 14));
  } else {
    G.dt = 0; pollInput();
    if (G.mode === 'title' || G.ambient) { G.dt = dt; G.time += dt; updateShips(dt); updateWorld(dt); }
    if (G.mode === 'title') updateCamera(rdt);
  }
  updateFx(G.mode === 'play' || G.mode === 'title' || G.ambient ? dt : 0);
  // le soleil et son ombre suivent la scène
  const c = G.cam, r = G.player.mode === 'helm' || G.mode === 'title' ? 46 : 26;
  if (r !== shadowR) { shadowR = r; const sc = sun.shadow.camera; sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.updateProjectionMatrix(); }
  sun.position.set(c.tx + SUN.x * 160, SUN.y * 160, c.tz + SUN.z * 160);
  sun.target.position.set(c.tx, 0, c.tz);
  sun.target.updateMatrixWorld();
  updateOcean(c.tx, c.tz);
  renderer.render(scene, camera);
  // résolution adaptative : on tient la fluidité avant la finesse
  acc += rdt; accN++;
  if (acc > 1.5) {
    const avg = acc / accN, before = prScale;
    if (avg > 1 / 44 && prScale > 0.55) prScale = Math.max(0.55, prScale - 0.1);
    else if (avg < 1 / 57 && prScale < 1) prScale = Math.min(1, prScale + 0.05);
    if (prScale !== before) resize();
    acc = 0; accN = 0;
  }
};

const boot = (data) => {
  app = document.getElementById('app');
  const canvas = document.getElementById('gl');
  G.isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const saved = (data && data.save) || P.loadSave();
  G.hasSave = !!saved;
  G.save = saved || P.newSave();
  if (!saved) G.save.opts.quality = G.isTouch ? 1 : 2;
  G.quality = G.save.opts.quality;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
  catch (e) { document.getElementById('err').hidden = false; return; }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(COL.horizon, 350, 2900);
  camera = new THREE.PerspectiveCamera(60, 1, 0.3, 6000);
  G.renderer = renderer; G.scene = scene; G.camera = camera;
  scene.add(new THREE.HemisphereLight(0xd8ecff, 0x9a8a68, 1.9));
  sun = new THREE.DirectionalLight(COL.sun, 3.4);
  sun.shadow.camera.near = 20; sun.shadow.camera.far = 400; sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);
  initMats(); initOcean(); initWorld(); initFx();
  G.ship = createShip('player', 0, 0, 0);
  placeAtDock(G.ship, islands[0]);
  applyUpgrades(G.ship, G.save.up);
  createPlayer();
  toDeck(G.player, 0, 2);
  P.startSortie(); P.applyLevel();
  spawnFleet();
  P.initProgression(); initCamera();
  initHud(app);
  initInput(canvas);
  on('start', startGame);
  on('toTitle', () => { G.mode = 'title'; showHud(false); openPanel('title'); });
  on('quality', applyQuality);
  applyQuality();
  G.cam.tx = G.ship.x; G.cam.tz = G.ship.z; G.cam.yaw = 2.2; G.cam.dist = 40;
  G.mode = 'title';
  openPanel('title');
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(app);
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.mode === 'play') emit('pause', {}); });
  // crochet de test : avance la simulation sans attendre le rendu
  window.__pirate = { G, P, islands, emit, toDeck, toWorld, placeAtDock, sim: (n, dt = 1 / 30) => { for (let i = 0; i < n; i++) { G.dt = dt; G.time += dt; pollInput(); step(dt); updateCamera(dt); updateHud(); } } };
  requestAnimationFrame(frame);
};

const hot = window.claude && window.claude.hot;
try { if (hot && hot.snapshot) hot.snapshot(() => ({ save: G.save })); } catch (e) { /* pas de reprise à chaud */ }
if (hot && hot.ready) hot.ready(boot); else boot((hot && hot.data) || {});
