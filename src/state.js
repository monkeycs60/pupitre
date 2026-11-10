// État partagé de la partie : un simple objet, pas de classes.
export const G = {
  time: 0, dt: 0, hitStop: 0, shake: 0,
  mode: 'title', // title | play | panel
  scene: null, camera: null, renderer: null,
  input: null, isTouch: false,
  ship: null, ships: [], player: null, enemies: [],
  save: null, sortie: null,
  cam: { yaw: 0, pitch: 0.3, dist: 6, rel: 0, tx: 0, ty: 0, tz: 0, fov: 60, aimBlend: 0 },
  activeIsland: null, zone: null,
  prompt: null, quality: 2,
};
const handlers = {};
export const on = (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); };
export const emit = (name, data) => { (handlers[name] || []).forEach((fn) => fn(data || {})); };
