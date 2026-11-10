import { G, on, emit } from './state.js';
import { LOOT, LEVELS, UNLOCKS, UPGRADES, UP_COST, PLANK_PRICE, BOUNTIES, PLAYER, ZONES, ZONE_LABEL, ZONE_MALUS } from './config.js';
import { islands, wrecks, rollLoot, dropLoot, resetSortieWorld, inSafe } from './world.js';
import { applyUpgrades, fullRepair, placeAtDock, spawnFleet, refreshShip } from './ship.js';
import { respawnOnDeck, damagePlayer } from './player.js';
import { deactivateIsland } from './enemies.js';
import { sfx } from './audio.js';
import { puff } from './fx.js';
import { fmt } from './util.js';

// Butin, expérience, primes et sauvegarde : tout se décide ici, jamais dans l'interface.
const KEY = 'jeu-pirate-v1';
const timers = [];
export const after = (sec, fn) => timers.push({ t: sec, fn });
export const updateTimers = (dt) => { for (let i = timers.length - 1; i >= 0; i--) { timers[i].t -= dt; if (timers[i].t <= 0) { const f = timers[i].fn; timers.splice(i, 1); f(); } } };

export const newSave = () => ({
  v: 1, gold: 0, level: 1, xp: 0, up: { hull: 0, sails: 0, cannons: 0, hold: 0 }, planks: 8, ammo: PLAYER.ammoMax, cargo: {},
  bounty: { offers: [], active: null, prog: 0, done: false }, doneFinal: false,
  stats: { sorties: 0, sunk: 0, kills: 0, gold: 0 }, opts: { quality: 2, sound: true, sens: 1 }, hints: {},
});
export const loadSave = () => {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) { const n = newSave(); return { ...n, ...s, up: { ...n.up, ...s.up }, opts: { ...n.opts, ...s.opts }, stats: { ...n.stats, ...s.stats } }; } } catch (e) { /* pas de sauvegarde lisible */ }
  return null;
};
export const writeSave = () => {
  if (G.player) G.save.ammo = G.player.ammo;
  try { localStorage.setItem(KEY, JSON.stringify(G.save)); return true; } catch (e) { return false; }
};
export const eraseSave = () => { try { localStorage.removeItem(KEY); } catch (e) { /* rien à effacer */ } };

export const capacity = () => UPGRADES.hold.mult[G.save.up.hold];
export const cargoCount = () => Object.values(G.save.cargo).reduce((a, b) => a + b, 0) + G.sortie.carried.length;
export const cargoValue = () => Object.entries(G.save.cargo).reduce((a, [k, n]) => a + LOOT[k].v * n, 0);
const lootText = (keys) => { const c = {}; keys.forEach((k) => { c[k] = (c[k] || 0) + 1; }); return Object.entries(c).map(([k, n]) => `${n > 1 ? n + ' × ' : ''}${LOOT[k].name}`).join(', '); };

export const applyLevel = () => {
  const p = G.player, l = G.save.level;
  p.lvl = l; p.maxHp = PLAYER.hp + 10 * (l - 1); p.maxSt = PLAYER.stamina + 6 * (l - 1); p.dmgMul = 1 + 0.05 * (l - 1);
};
export const xpInfo = () => { const l = G.save.level, a = LEVELS[l - 1], b = LEVELS[l]; return b === undefined ? { f: 1, next: null } : { f: (G.save.xp - a) / (b - a), next: b - G.save.xp }; };
export const addXp = (n) => {
  const s = G.save;
  s.xp += Math.round(n);
  while (s.level < LEVELS.length && s.xp >= LEVELS[s.level]) {
    s.level++; applyLevel();
    G.player.hp = G.player.maxHp; G.player.st = G.player.maxSt;
    sfx('level');
    emit('banner', { title: `Niveau ${s.level}`, sub: UNLOCKS[s.level] ? `Nouvelle action : ${UNLOCKS[s.level]}` : 'Vie et endurance augmentées' });
  }
};

// ----- butin -----
const addCarried = (keys, planks = 0) => {
  const room = capacity() - cargoCount(), take = keys.slice(0, Math.max(0, room));
  take.forEach((k) => G.sortie.carried.push(k));
  if (planks) G.save.planks += planks;
  if (take.length || planks) { sfx('coin'); emit('toast', { text: `+ ${[lootText(take), planks ? `${planks} planches` : ''].filter(Boolean).join(', ')}` }); }
  if (take.length < keys.length) emit('toast', { text: 'Cale pleine : rentre vendre au port', key: 'full' });
  return take.length;
};
const stow = () => {
  const c = G.sortie.carried;
  if (!c.length) return;
  c.forEach((k) => { G.save.cargo[k] = (G.save.cargo[k] || 0) + 1; });
  emit('toast', { text: `Butin mis en cale : ${lootText(c)}` });
  G.sortie.carried = [];
};

const bountyEvent = (ev, match) => {
  const b = G.save.bounty, def = BOUNTIES.find((q) => q.id === b.active);
  if (!def || b.done || def.ev !== ev || (def.match && def.match !== match)) return;
  b.prog++;
  if (b.prog >= def.n) { b.done = true; sfx('level'); emit('banner', { title: 'Prime accomplie', sub: 'Rentre au port toucher la récompense' }); }
  else emit('toast', { text: `Prime : ${b.prog} / ${def.n}` });
};
export const refreshOffers = () => {
  const b = G.save.bounty, pool = BOUNTIES.filter((q) => !q.final && q.id !== b.active).sort(() => Math.random() - 0.5).slice(0, 3);
  b.offers = [...pool.map((q) => q.id), 'fort'];
};
export const acceptBounty = (id) => { const b = G.save.bounty; b.active = id; b.prog = 0; b.done = false; sfx('ui'); };
export const dropBounty = () => { const b = G.save.bounty; b.active = null; b.prog = 0; b.done = false; };
export const claimBounty = () => {
  const b = G.save.bounty, def = BOUNTIES.find((q) => q.id === b.active);
  if (!def || !b.done) return;
  G.save.gold += def.gold; G.save.stats.gold += def.gold; addXp(def.xp);
  b.active = null; b.prog = 0; b.done = false;
  refreshOffers(); sfx('coin'); writeSave();
};

// ----- port -----
export const sellAll = () => {
  const v = cargoValue();
  if (!v) return 0;
  G.save.gold += v; G.save.stats.gold += v; G.save.cargo = {};
  sfx('coin'); writeSave();
  return v;
};
export const buyPlanks = (n) => { if (G.save.gold < n * PLANK_PRICE) return false; G.save.gold -= n * PLANK_PRICE; G.save.planks += n; sfx('ui'); writeSave(); return true; };
export const repairCost = () => { const s = G.ship; return Math.ceil(((s.hullMax - s.hull) + ZONES.reduce((a, zk) => a + s.zones[zk].max - s.zones[zk].hp, 0)) / 4); };
export const repairShip = () => { const c = repairCost(); if (!c || G.save.gold < c) return false; G.save.gold -= c; fullRepair(G.ship); sfx('repair'); writeSave(); return true; };
export const upgradeCost = (key) => UP_COST[G.save.up[key]] || null;
export const buyUpgrade = (key) => {
  const c = upgradeCost(key);
  if (!c || G.save.gold < c[0] || G.save.planks < c[1]) return false;
  G.save.gold -= c[0]; G.save.planks -= c[1]; G.save.up[key]++;
  applyUpgrades(G.ship, G.save.up); sfx('level'); writeSave();
  return true;
};

const arrivePort = () => {
  const so = G.sortie, p = G.player;
  p.ammo = PLAYER.ammoMax; p.reloadT = 0;
  if (so.started) {
    so.started = false; G.save.stats.sorties++;
    emit('toast', { text: `Sortie de ${Math.max(1, Math.round(so.time / 60))} min terminée. Butin en cale : ${fmt(cargoValue())} or.` });
    so.time = 0;
    resetSortieWorld(); spawnFleet();
  }
  writeSave();
  emit('toast', { text: 'Partie sauvegardée', key: 'saved' });
};

export const startSortie = () => { G.sortie = { carried: [], time: 0, started: false }; };

export const updateProgression = (dt) => {
  const s = G.ship, so = G.sortie;
  if (!so.started && !inSafe(s.x, s.z)) { so.started = true; so.time = 0; }
  if (so.started) so.time += dt;
};

export const initProgression = () => {
  on('kill', ({ type, e }) => { addXp(e.def.xp * (e.maxHp < e.def.hp ? 0.7 : 1)); G.save.stats.kills++; bountyEvent('kill', type); if (type === 'capitaine') victory(); });
  on('cleared', ({ key }) => bountyEvent('cleared', key));
  on('sunk', ({ ship, byPlayer }) => {
    if (ship === G.ship) return playerSunk();
    if (byPlayer) { addXp(ship.sp.xp); G.save.stats.sunk++; bountyEvent('sunk', ship.kind); emit('toast', { text: `${ship.sp.label} coulé : récupère les caisses` }); }
  });
  on('zoneDown', ({ ship, zone }) => {
    if (ship === G.ship) { sfx('warn'); emit('toast', { text: `${ZONE_LABEL[zone]} détruit : ${ZONE_MALUS[zone]}`, key: 'zd' + zone }); }
    else if (G.player.mode === 'helm') emit('toast', { text: `Ennemi : ${ZONE_LABEL[zone].toLowerCase()} détruit` });
  });
  on('chest', ({ chest }) => { addCarried(rollLoot('chest' + chest.tier, 2 + chest.tier), chest.tier); bountyEvent('chest', ''); addXp(6 * chest.tier); });
  on('seaLoot', (p) => {
    const room = capacity() - cargoCount();
    if (room <= 0) { emit('toast', { text: 'Cale pleine : rentre vendre au port', key: 'full' }); return; }
    const keys = rollLoot(p.table, 2).slice(0, room), planks = Math.random() < 0.6 ? 2 : 0;
    keys.forEach((k) => { G.save.cargo[k] = (G.save.cargo[k] || 0) + 1; });
    G.save.planks += planks; p.taken = true; sfx('coin');
    emit('toast', { text: `+ ${[lootText(keys), planks ? `${planks} planches` : ''].filter(Boolean).join(', ')}` });
    puff('gold', p.x, 1.5, p.z, 10);
    if (p.wreck >= 0 && !wrecks[p.wreck].looted) { wrecks[p.wreck].looted = true; bountyEvent('wreck', ''); }
  });
  on('groundLoot', (p) => {
    const pl = G.player;
    if (p.ammo && pl.ammo < PLAYER.ammoMax) { pl.ammo = Math.min(PLAYER.ammoMax, pl.ammo + p.ammo); p.ammo = 0; emit('toast', { text: '+ munitions', key: 'am' }); }
    const got = addCarried(p.loot);
    p.loot = p.loot.slice(got);
    if (!p.loot.length) p.taken = true;
    if (got) puff('gold', p.x, p.y + 0.6, p.z, 8);
  });
  on('boarded', stow);
  on('landed', ({ isl }) => emit('banner', { title: isl.name, sub: isl.sub }));
  on('moored', ({ isl }) => { emit('toast', { text: `Amarré : ${isl.name}`, key: 'moor' }); sfx('creak'); if (isl.safe) arrivePort(); });
  on('deckHit', ({ x, z }) => { const p = G.player; if (p.aboard && Math.hypot(p.x - x, p.z - z) < 3.4) damagePlayer(12, { sea: true }); });
  on('playerDied', () => {
    const p = G.player, so = G.sortie;
    if (p.respawning) return;
    p.respawning = true;
    emit('fade', {
      text: p.mode === 'world' && so.carried.length ? 'Tu te réveilles sur le pont. Ton butin est resté là où tu es tombé.' : 'Tu te réveilles sur le pont.',
      mid: () => {
        if (p.mode === 'world' && so.carried.length) { dropLoot(p.x, p.y, p.z, so.carried, 0, true); so.carried = []; }
        respawnOnDeck(p);
        p.hp = p.maxHp; p.st = p.maxSt; p.respawning = false;
      },
    });
  });
};

const playerSunk = () => {
  sfx('lose');
  after(3.2, () => {
    const s = G.ship, p = G.player, port = islands[0];
    const lost = cargoValue(), cost = Math.min(G.save.gold, 60 + Math.ceil(s.hullMax / 4));
    emit('fade', {
      text: `Ton sloop a coulé. Cargaison perdue${lost ? ` (${fmt(lost)} or)` : ''}, réparation : ${fmt(cost)} or. Niveaux et améliorations sont conservés.`,
      hold: 2.6,
      mid: () => {
        G.save.cargo = {}; G.sortie.carried = []; G.save.gold -= cost;
        s.alive = true; s.sink = 0; s.group.visible = true; s.heave = 0; s.pitch = 0; s.roll = 0;
        fullRepair(s); placeAtDock(s, port); refreshShip(s);
        if (G.activeIsland) { deactivateIsland(G.activeIsland); G.activeIsland = null; }
        respawnOnDeck(p);
        p.hp = p.maxHp; p.dead = false; p.respawning = false; p.ammo = PLAYER.ammoMax;
        G.sortie.started = false; G.sortie.time = 0;
        resetSortieWorld(); spawnFleet(); writeSave();
      },
    });
  });
};

const victory = () => {
  const first = !G.save.doneFinal;
  G.save.doneFinal = true;
  after(2.6, () => { sfx('win'); emit('victory', { first }); });
};
