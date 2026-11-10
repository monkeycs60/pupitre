import { G } from './state.js';
import { clamp } from './util.js';

// Tous les sons sont synthétisés (pas de fichiers) : bruit filtré et oscillateurs.
let ctx = null, master = null, noiseBuf = null, sea = null, seaGain = null;
export const audioState = { on: true };

export const initAudio = () => {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = audioState.on ? 0.7 : 0; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    sea = ctx.createBufferSource(); sea.buffer = noiseBuf; sea.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
    seaGain = ctx.createGain(); seaGain.gain.value = 0.05;
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.13; lg.gain.value = 0.025;
    lfo.connect(lg); lg.connect(seaGain.gain); lfo.start();
    sea.connect(lp); lp.connect(seaGain); seaGain.connect(master); sea.start();
  } catch (e) { ctx = null; }
};
export const setSound = (on) => { audioState.on = on; if (master) master.gain.value = on ? 0.7 : 0; };
export const setAmbience = (speed01) => { if (seaGain) seaGain.gain.setTargetAtTime(0.045 + speed01 * 0.07, ctx.currentTime, 0.5); };

const noise = (dur, f, f2, g, type = 'lowpass', q = 0.8, delay = 0) => {
  const t = ctx.currentTime + delay, s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), gn = ctx.createGain();
  s.buffer = noiseBuf; fl.type = type; fl.Q.value = q;
  fl.frequency.setValueAtTime(f, t); fl.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t + dur);
  gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(g, t + 0.006); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(fl); fl.connect(gn); gn.connect(master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
};
const tone = (f, f2, dur, g, type = 'sine', delay = 0) => {
  const t = ctx.currentTime + delay, o = ctx.createOscillator(), gn = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(g, t + 0.008); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(gn); gn.connect(master); o.start(t); o.stop(t + dur + 0.05);
};

const S = {
  cannon: (v) => { noise(0.9, 1400, 70, 0.9 * v); tone(95, 32, 0.55, 0.8 * v); },
  splash: (v) => noise(0.5, 2600, 500, 0.3 * v, 'bandpass', 0.7),
  wood: (v) => { noise(0.25, 900, 180, 0.7 * v); tone(140, 60, 0.18, 0.4 * v, 'triangle'); },
  swing: (v) => noise(0.16, 700, 3200, 0.22 * v, 'bandpass', 1.4),
  cut: (v) => { noise(0.12, 3800, 900, 0.5 * v, 'highpass'); tone(210, 90, 0.12, 0.35 * v, 'square'); },
  clang: (v) => { tone(1900, 1500, 0.3, 0.3 * v, 'triangle'); tone(2850, 2400, 0.22, 0.2 * v, 'sine'); noise(0.06, 5000, 2000, 0.3 * v, 'highpass'); },
  musket: (v) => { noise(0.3, 3200, 300, 0.8 * v); tone(190, 55, 0.2, 0.5 * v, 'sawtooth'); },
  hurt: (v) => { tone(170, 80, 0.22, 0.45 * v, 'sawtooth'); noise(0.12, 800, 200, 0.35 * v); },
  roll: (v) => noise(0.22, 500, 1400, 0.16 * v, 'bandpass', 0.9),
  coin: (v) => { tone(1320, 1320, 0.07, 0.2 * v, 'square'); tone(1760, 1760, 0.14, 0.2 * v, 'square', 0.07); },
  ui: (v) => tone(660, 520, 0.06, 0.15 * v, 'triangle'),
  sail: (v) => noise(0.35, 400, 1200, 0.22 * v, 'bandpass', 0.6),
  creak: (v) => tone(120, 85, 0.35, 0.12 * v, 'sawtooth'),
  repair: (v) => { noise(0.05, 1800, 600, 0.4 * v); tone(320, 240, 0.06, 0.25 * v, 'square'); },
  level: (v) => [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.22, 0.2 * v, 'triangle', i * 0.09)),
  win: (v) => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, f, 0.4, 0.2 * v, 'triangle', i * 0.13)),
  lose: (v) => [392, 330, 262, 196].forEach((f, i) => tone(f, f * 0.97, 0.4, 0.22 * v, 'sawtooth', i * 0.16)),
  sink: (v) => { noise(1.6, 900, 90, 0.5 * v); tone(80, 35, 1.4, 0.4 * v); },
  chest: (v) => { tone(220, 330, 0.18, 0.25 * v, 'triangle'); tone(660, 880, 0.2, 0.2 * v, 'triangle', 0.12); },
  warn: (v) => tone(440, 330, 0.2, 0.2 * v, 'square'),
};
export const sfx = (name, vol = 1) => { if (ctx && audioState.on && vol > 0.02) { try { S[name](vol); } catch (e) { /* son ignoré */ } } };
// son localisé : volume selon la distance à la caméra
export const sfxAt = (name, x, z, range = 260) => {
  const c = G.camera.position, d = Math.hypot(x - c.x, z - c.z);
  sfx(name, clamp(1 - d / range, 0, 1) ** 1.5);
};
