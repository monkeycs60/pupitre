import { G, emit } from './state.js';
import { clamp } from './util.js';

// Clavier/souris, tactile et manette alimentent le même objet d'intentions G.input.
// Les touches sont lues par position (event.code) : ZQSD sur AZERTY = WASD sur QWERTY.
const keys = {}, pressed = {}, mouse = { l: false, r: false, lp: false, dx: 0, dy: 0 };
const tb = {}; // boutons tactiles : { down, pressed, released }
const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 }, look = { id: null, x: 0, y: 0, dx: 0, dy: 0 };
let labels = null, padPrev = [];
export const inputState = { locked: false, joy, usedPad: false };

const AZERTY = { KeyW: 'Z', KeyA: 'Q', KeyQ: 'A', KeyM: ',' }, learned = {};
const french = /^fr/i.test(navigator.language || '');
export const keyLabel = (code) => {
  if (code === 'Space') return 'Espace';
  if (code === 'ShiftLeft') return 'Maj';
  if (code === 'Escape') return 'Échap';
  if (code === 'Tab') return 'Tab';
  const l = (labels && labels.get(code)) || learned[code];
  return l ? l.toUpperCase() : (french && AZERTY[code]) || code.replace('Key', '');
};

export const touchBtn = (name, down) => {
  const b = tb[name] || (tb[name] = { down: false, pressed: false, released: false });
  if (down && !b.down) b.pressed = true;
  if (!down && b.down) b.released = true;
  b.down = down;
};

export const requestLock = () => {
  if (G.isTouch || inputState.locked) return;
  try { const r = G.renderer.domElement.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* verrouillage indisponible */ }
};

export const initInput = (layer) => {
  G.input = { mx: 0, my: 0, lookX: 0, lookY: 0 };
  if (navigator.keyboard && navigator.keyboard.getLayoutMap) navigator.keyboard.getLayoutMap().then((m) => { labels = m; emit('labels', {}); }).catch(() => {});
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (!keys[e.code]) pressed[e.code] = true;
    if (/^Key/.test(e.code) && e.key && e.key.length === 1 && learned[e.code] !== e.key) { learned[e.code] = e.key; emit('labels', {}); }
    keys[e.code] = true;
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && G.mode === 'play') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { Object.keys(keys).forEach((k) => { keys[k] = false; }); mouse.l = mouse.r = false; });
  const cv = G.renderer.domElement;
  cv.addEventListener('mousedown', (e) => {
    if (G.isTouch) return;
    if (e.button === 0) { mouse.l = true; mouse.lp = true; }
    if (e.button === 2) mouse.r = true;
    if (G.mode === 'play') requestLock();
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.l = false; if (e.button === 2) mouse.r = false; });
  window.addEventListener('mousemove', (e) => {
    if (G.isTouch) return;
    if (inputState.locked || mouse.l || mouse.r) { mouse.dx += e.movementX || 0; mouse.dy += e.movementY || 0; }
  });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    const was = inputState.locked;
    inputState.locked = document.pointerLockElement === cv;
    if (was && !inputState.locked && G.mode === 'play') emit('pause', {});
  });
  // tactile : moitié gauche = joystick, le reste = caméra
  const down = (e) => {
    if (e.pointerType === 'mouse') return;
    if (!G.isTouch) { G.isTouch = true; emit('touchMode', {}); }
    if (joy.id === null && e.clientX < window.innerWidth * 0.45) { joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.x = joy.y = 0; }
    else if (look.id === null) { look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY; }
    e.preventDefault();
  };
  const move = (e) => {
    if (e.pointerId === joy.id) { const R = 52; joy.x = clamp((e.clientX - joy.ox) / R, -1, 1); joy.y = clamp((e.clientY - joy.oy) / R, -1, 1); const m = Math.hypot(joy.x, joy.y); if (m > 1) { joy.x /= m; joy.y /= m; } }
    else if (e.pointerId === look.id) { look.dx += e.clientX - look.x; look.dy += e.clientY - look.y; look.x = e.clientX; look.y = e.clientY; }
  };
  const up = (e) => { if (e.pointerId === joy.id) { joy.id = null; joy.x = joy.y = 0; } if (e.pointerId === look.id) look.id = null; };
  layer.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
};

const tp = (n) => !!(tb[n] && tb[n].pressed), td = (n) => !!(tb[n] && tb[n].down), tr = (n) => !!(tb[n] && tb[n].released);

export const pollInput = () => {
  const I = G.input, sens = (G.save ? G.save.opts.sens : 1);
  const helm = G.player && G.player.mode === 'helm';
  let mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), my = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  mx += joy.x; my -= joy.y;
  let lx = mouse.dx * 0.0026 + look.dx * 0.0062, ly = mouse.dy * 0.0022 + look.dy * 0.0048;
  lx += ((keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0)) * 2.2 * G.dt; ly += ((keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0)) * 1.4 * G.dt;
  I.dragging = look.id !== null;
  I.attack = !helm && ((mouse.lp && !mouse.r) || tp('atk'));
  I.heavy = !!pressed.KeyF || tp('heavy');
  I.parry = !!keys.KeyQ || !!keys.KeyC || td('parry');
  I.roll = !!pressed.ShiftLeft || !!pressed.ShiftRight || tp('roll');
  I.jump = (!helm && !!pressed.Space) || tp('jump');
  I.aim = mouse.r || td('gun') || tr('gun');
  I.fire = (mouse.lp && (mouse.r || helm)) || tr('gun') || (helm && !!pressed.Space);
  I.interact = !!pressed.KeyE || tp('use');
  I.interactHeld = !!keys.KeyE || td('use');
  I.sailUp = helm && (!!pressed.KeyW || !!pressed.ArrowUp) || tp('sailUp');
  I.sailDown = helm && (!!pressed.KeyS || !!pressed.ArrowDown) || tp('sailDown');
  I.fireL = tp('fireL'); I.fireR = tp('fireR');
  I.shot = (helm && !!pressed.KeyR) || tp('shot');
  I.map = !!pressed.KeyM || !!pressed.Tab || tp('map');
  I.pause = !!pressed.Escape || !!pressed.KeyP || tp('pause');
  // manette (disposition standard)
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && Array.from(pads).find((g) => g && g.mapping === 'standard');
  if (gp) {
    const ax = (i) => (Math.abs(gp.axes[i]) > 0.16 ? gp.axes[i] : 0), b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed), e = (i) => b(i) && !padPrev[i];
    mx += ax(0); my -= ax(1); lx += ax(2) * 2.6 * G.dt; ly += ax(3) * 1.8 * G.dt;
    I.attack = I.attack || (!helm && e(2)); I.heavy = I.heavy || e(3); I.parry = I.parry || b(4); I.roll = I.roll || e(1); I.jump = I.jump || (!helm && e(0));
    I.aim = I.aim || (!helm && b(6)); I.fire = I.fire || (!helm && e(7));
    I.interact = I.interact || e(5); I.interactHeld = I.interactHeld || b(5);
    I.sailUp = I.sailUp || (helm && e(12)); I.sailDown = I.sailDown || (helm && e(13));
    I.fireL = I.fireL || (helm && e(6)); I.fireR = I.fireR || (helm && e(7)); I.shot = I.shot || (helm && e(3));
    I.map = I.map || e(8); I.pause = I.pause || e(9);
    padPrev = gp.buttons.map((q) => q.pressed);
    if (padPrev.some(Boolean)) inputState.usedPad = true;
  }
  if (helm) { I.sailUp = I.sailUp || false; if (keys.ArrowUp || keys.ArrowDown) ly = mouse.dy * 0.0022 + look.dy * 0.0048; }
  I.mx = clamp(mx, -1, 1); I.my = clamp(my, -1, 1);
  I.lookX = lx * sens; I.lookY = ly * sens;
  mouse.dx = mouse.dy = 0; look.dx = look.dy = 0; mouse.lp = false;
  for (const k in pressed) delete pressed[k];
  for (const k in tb) { tb[k].pressed = false; tb[k].released = false; }
};
