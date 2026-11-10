import { G, on, emit } from './state.js';
import { clamp, fmt, wrap, TAU } from './util.js';
import { LOOT, UPGRADES, BOUNTIES, ZONES, ZONE_LABEL, SAIL_LABEL, UNLOCKS, PLANK_PRICE, WORLD, LEVELS } from './config.js';
import { islands, radiusAt, wrecks, seaPickups } from './world.js';
import { knots } from './ship.js';
import { keyLabel, touchBtn, inputState, requestLock } from './input.js';
import { sfx, setSound, initAudio } from './audio.js';
import * as P from './progression.js';

const $ = (id) => document.getElementById(id);
const el = {};
let panel = null, portTab = 'marchand', mapImg = null, toastKeys = {}, last = {}, fadeBusy = false, confirmNew = false, mapFrame = 0;
const MAPPX = 512, MAPSPAN = 2500;

const set = (key, node, val, prop = 'textContent') => { if (last[key] !== val) { last[key] = val; node[prop] = val; } };
const width = (key, node, f) => { const v = Math.round(clamp(f, 0, 1) * 1000) / 10; if (last[key] !== v) { last[key] = v; node.style.width = v + '%'; } };

const toast = (text, key) => {
  const now = performance.now();
  if (key) { if (toastKeys[key] && now - toastKeys[key] < 3500) return; toastKeys[key] = now; }
  const d = document.createElement('div');
  d.className = 'toast'; d.textContent = text;
  el.toasts.appendChild(d);
  while (el.toasts.children.length > 4) el.toasts.firstChild.remove();
  setTimeout(() => d.classList.add('out'), 3200);
  setTimeout(() => d.remove(), 3700);
};
let bannerT = null;
const banner = (title, sub) => {
  el.banner.querySelector('h2').textContent = title;
  el.banner.querySelector('p').textContent = sub || '';
  el.banner.classList.add('on');
  clearTimeout(bannerT);
  bannerT = setTimeout(() => el.banner.classList.remove('on'), 3400);
};

// fondu au noir avec message : mort, naufrage
const fade = ({ text, mid, hold = 1.5 }) => {
  if (fadeBusy) { if (mid) mid(); return; }
  fadeBusy = true;
  const prev = G.mode;
  el.fade.querySelector('p').textContent = text || '';
  el.fade.classList.add('on');
  setTimeout(() => {
    G.mode = 'panel';
    if (mid) mid();
    setTimeout(() => { el.fade.classList.remove('on'); G.mode = prev === 'panel' ? 'play' : prev; fadeBusy = false; }, hold * 1000);
  }, 650);
};

// ----- carte -----
const buildMap = () => {
  const c = document.createElement('canvas');
  c.width = c.height = MAPPX;
  const g = c.getContext('2d'), k = MAPPX / MAPSPAN, ox = WORLD.cx - MAPSPAN / 2, oz = WORLD.cz - MAPSPAN / 2;
  islands.forEach((isl) => {
    [[1.0, '#e2cf9a'], [0.8, '#6aa650']].forEach(([sc, col]) => {
      g.beginPath();
      for (let i = 0; i <= 48; i++) { const a = (i / 48) * TAU, r = radiusAt(isl, a) * sc; g.lineTo((isl.x + Math.sin(a) * r - ox) * k, (isl.z + Math.cos(a) * r - oz) * k); }
      g.fillStyle = isl.fort && sc < 1 ? '#8d8a7c' : col; g.fill();
    });
    const d = isl.dock;
    g.strokeStyle = '#6b4a2e'; g.lineWidth = 2; g.beginPath();
    g.moveTo((isl.x + d.ux * d.s0 - ox) * k, (isl.z + d.uz * d.s0 - oz) * k); g.lineTo((isl.x + d.ux * d.s1 - ox) * k, (isl.z + d.uz * d.s1 - oz) * k); g.stroke();
  });
  mapImg = c;
};
const drawMap = (cv, full) => {
  const g = cv.getContext('2d'), W = cv.width, s = G.ship, p = G.player;
  const span = full ? MAPSPAN * 0.9 : 620, cx = full ? WORLD.cx : s.x, cz = full ? WORLD.cz : s.z, k = W / span;
  const X = (x) => (x - cx) * k + W / 2, Z = (z) => (z - cz) * k + W / 2;
  g.clearRect(0, 0, W, W);
  g.save();
  if (!full) { g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 2, 0, TAU); g.clip(); }
  g.fillStyle = full ? '#143a4c' : 'rgba(13,48,64,.82)'; g.fillRect(0, 0, W, W);
  const mk = MAPPX / MAPSPAN, sw = span * mk;
  g.drawImage(mapImg, (cx - span / 2 - (WORLD.cx - MAPSPAN / 2)) * mk, (cz - span / 2 - (WORLD.cz - MAPSPAN / 2)) * mk, sw, sw, 0, 0, W, W);
  if (full) { g.strokeStyle = 'rgba(239,227,200,.25)'; g.setLineDash([6, 6]); g.beginPath(); g.arc(X(WORLD.cx), Z(WORLD.cz), WORLD.radius * k, 0, TAU); g.stroke(); g.setLineDash([]); }
  const u = full ? W / 330 : W / 140;
  wrecks.forEach((w) => { if (w.looted) return; g.strokeStyle = '#efe3c8'; g.lineWidth = 1.6 * u; g.beginPath(); g.moveTo(X(w.x) - 3 * u, Z(w.z) - 3 * u); g.lineTo(X(w.x) + 3 * u, Z(w.z) + 3 * u); g.moveTo(X(w.x) + 3 * u, Z(w.z) - 3 * u); g.lineTo(X(w.x) - 3 * u, Z(w.z) + 3 * u); g.stroke(); });
  seaPickups.forEach((q) => { if (q.wreck >= 0) return; g.fillStyle = '#f2c94c'; g.fillRect(X(q.x) - 1.5 * u, Z(q.z) - 1.5 * u, 3 * u, 3 * u); });
  const tri = (x, z, th, col, sz) => { g.save(); g.translate(X(x), Z(z)); g.rotate(-th + Math.PI); g.fillStyle = col; g.beginPath(); g.moveTo(0, -sz); g.lineTo(sz * 0.62, sz * 0.8); g.lineTo(-sz * 0.62, sz * 0.8); g.fill(); g.restore(); };
  G.ships.forEach((q) => { if (q === s || !q.alive) return; if (!full && Math.hypot(q.x - s.x, q.z - s.z) > 330) return; if (full && Math.hypot(q.x - s.x, q.z - s.z) > 450) return; tri(q.x, q.z, q.th, '#e0503c', (q.kind === 'galion' ? 6.5 : 4.5) * u); });
  G.enemies.forEach((e) => { if (!e.alive || full) return; g.fillStyle = '#e0503c'; g.beginPath(); g.arc(X(e.x), Z(e.z), 1.8 * u, 0, TAU); g.fill(); });
  // objectif : la prime en cours (ou le port quand elle est accomplie), ramené au bord de la mini-carte
  const bo = G.save.bounty, bd = BOUNTIES.find((q) => q.id === bo.active), ti = bd && (bo.done ? islands[0] : islands.find((i) => i.id === bd.at));
  if (ti) {
    let mx = X(ti.x) - W / 2, mz = Z(ti.z) - W / 2;
    const m = Math.hypot(mx, mz), lim = W / 2 - 9 * u;
    if (!full && m > lim) { mx *= lim / m; mz *= lim / m; }
    g.strokeStyle = '#f2c94c'; g.lineWidth = 2 * u; g.beginPath(); g.arc(W / 2 + mx, W / 2 + mz, (4 + 1.5 * Math.sin(performance.now() / 250)) * u, 0, TAU); g.stroke();
  }
  tri(s.x, s.z, s.th, '#efe3c8', 6 * u);
  if (!p.aboard) { g.fillStyle = '#f2c94c'; g.beginPath(); g.arc(X(p.x), Z(p.z), 2.4 * u, 0, TAU); g.fill(); }
  if (full) {
    g.font = `${Math.round(W / 34)}px "IM Fell English SC", Georgia, serif`; g.textAlign = 'center';
    islands.forEach((isl) => { g.fillStyle = '#0b1820'; g.fillText(isl.name, X(isl.x) + 1, Z(isl.z) - isl.r * k - 5); g.fillStyle = '#efe3c8'; g.fillText(isl.name, X(isl.x), Z(isl.z) - isl.r * k - 6); });
  }
  g.restore();
  if (!full) { g.strokeStyle = 'rgba(216,164,65,.9)'; g.lineWidth = 2; g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 2, 0, TAU); g.stroke(); g.fillStyle = '#d8a441'; g.font = `600 ${11 * u}px "Alegreya Sans", sans-serif`; g.textAlign = 'center'; g.fillText('N', W / 2, 13 * u); }
};

// ----- panneaux -----
const kb = (code) => `<kbd>${keyLabel(code)}</kbd>`;
const controls = () => (G.isTouch
  ? `<ul class="ctl"><li><b>Pouce gauche</b> se déplacer, tenir la barre</li><li><b>Glisser à droite</b> regarder autour</li><li><b>Tir</b> maintenir pour viser, relâcher pour tirer</li><li><b>À la barre</b> boutons voiles ▲▼, Bâbord et Tribord pour les bordées</li></ul>`
  : `<ul class="ctl"><li>${kb('KeyW')}${kb('KeyA')}${kb('KeyS')}${kb('KeyD')} se déplacer · à la barre : voiles et gouvernail</li><li><b>Souris</b> regarder · <b>clic</b> sabre, ou bordée du côté regardé</li><li><b>Clic droit</b> viser au mousquet, puis clic pour tirer</li><li>${kb('ShiftLeft')} esquive · ${kb('Space')} saut · ${kb('KeyE')} interagir (maintenir pour colmater)</li><li>${kb('KeyQ')} parade (niv. 2) · ${kb('KeyF')} coup lourd (niv. 3) · ${kb('KeyR')} viser coque ou voiles</li><li>${kb('KeyM')} carte · ${kb('Escape')} pause · manette prise en charge</li></ul>`);
const opts = () => {
  const o = G.save.opts;
  return `<div class="opts"><span>Qualité</span><div class="seg">${['Basse', 'Moyenne', 'Haute'].map((n, i) => `<button class="${o.quality === i ? 'on' : ''}" data-act="quality" data-arg="${i}">${n}</button>`).join('')}</div>
  <span>Son</span><div class="seg"><button class="${o.sound ? 'on' : ''}" data-act="sound" data-arg="1">Activé</button><button class="${o.sound ? '' : 'on'}" data-act="sound" data-arg="0">Coupé</button></div>
  <span>Caméra</span><div class="seg">${[['Lente', 0.7], ['Normale', 1], ['Vive', 1.4]].map(([n, v]) => `<button class="${o.sens === v ? 'on' : ''}" data-act="sens" data-arg="${v}">${n}</button>`).join('')}</div></div>`;
};
const head = () => `<div class="purse"><span><b>${fmt(G.save.gold)}</b> or</span><span><b>${P.cargoCount()}</b> / ${P.capacity()} en cale</span><span><b>${G.save.planks}</b> planches</span></div>`;
const zoneState = (z) => (z.dead ? 'détruit' : z.hp < z.max * 0.6 ? 'abîmé' : 'intact');

const R = {
  title: () => `<div class="title"><p class="eyebrow">v1 · solo d’abord</p><h1>Jeu pirate</h1>
    <p class="lede">Du pont à la barre, de la bordée au sabre, sans coupure. Une sortie dure un quart d’heure et finit toujours par un achat au port.</p>
    <div class="row">${G.hasSave ? `<button class="btn" data-act="continue">Continuer · niveau ${G.save.level}</button><button class="btn ghost" data-act="${confirmNew ? 'new' : 'asknew'}">${confirmNew ? 'Effacer la sauvegarde et recommencer' : 'Nouvelle partie'}</button>` : '<button class="btn" data-act="new">Lever l’ancre</button>'}
    <button class="btn ghost" data-act="fs">Plein écran</button></div>${controls()}${opts()}</div>`,
  pause: () => `<h2>Pause</h2><div class="row"><button class="btn" data-act="close">Reprendre</button><button class="btn ghost" data-act="map">Carte</button><button class="btn ghost" data-act="fs">Plein écran</button><button class="btn ghost" data-act="totitle">Écran titre</button></div>${controls()}${opts()}
    <p class="note">La partie est sauvegardée à chaque amarrage à Port-Liberté.</p>`,
  map: () => `<h2>Carte</h2><canvas id="bigmap" width="900" height="900"></canvas><p class="note">Voile claire : ton sloop. Rouge : navires repérés par la vigie. Croix : épaves à fouiller.</p><div class="row"><button class="btn" data-act="close">Fermer</button></div>`,
  victory: (a) => `<p class="eyebrow">Fort de la Couronne</p><h2>Le fort est tombé</h2><p class="lede">${a && a.first ? 'Le capitaine est mort, la v1 est bouclée.' : 'Le capitaine est retombé.'} ${G.save.stats.sorties} sorties, ${G.save.stats.sunk} navires coulés, ${G.save.stats.kills} ennemis abattus, ${fmt(G.save.stats.gold)} or gagné.</p><p class="note">La mer reste ouverte : primes, améliorations et butin continuent.</p><div class="row"><button class="btn" data-act="close">Continuer à naviguer</button></div>`,
  port: () => {
    const s = G.save, tabs = [['marchand', 'Marchand'], ['chantier', 'Chantier naval'], ['primes', 'Primes'], ['capitaine', 'Capitaine']];
    let body = '';
    if (portTab === 'marchand') {
      const rows = Object.entries(s.cargo).filter(([, n]) => n > 0).map(([k, n]) => `<tr><td>${LOOT[k].name}</td><td class="n">${n}</td><td class="n">${LOOT[k].v} or</td><td class="n">${fmt(n * LOOT[k].v)} or</td></tr>`).join('');
      body = `<h3>Butin en cale</h3>${rows ? `<table><thead><tr><th>Marchandise</th><th class="n">Qté</th><th class="n">Prix fixe</th><th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table>
        <button class="btn" data-act="sell">Tout vendre · ${fmt(P.cargoValue())} or</button>` : '<p class="note">La cale est vide. Le butin se ramasse en mer et sur les îles, puis se vend ici.</p>'}
        <h3>Fournitures</h3><div class="line"><div><b>Planches</b><small>Colmater en mer, améliorer au chantier · ${PLANK_PRICE} or pièce</small></div><div class="row"><button class="btn ghost" data-act="planks" data-arg="1" ${s.gold < PLANK_PRICE ? 'disabled' : ''}>+1</button><button class="btn ghost" data-act="planks" data-arg="5" ${s.gold < PLANK_PRICE * 5 ? 'disabled' : ''}>+5</button></div></div>
        <div class="line"><div><b>Munitions</b><small>Giberne refaite gratuitement à chaque amarrage au port</small></div><span class="ok">${G.player.ammo} balles</span></div>`;
    } else if (portTab === 'chantier') {
      const cost = P.repairCost(), sh = G.ship;
      body = `<h3>Réparations</h3><div class="line"><div><b>Coque ${Math.round((sh.hull / sh.hullMax) * 100)} %</b><small>${ZONES.map((zk) => `${ZONE_LABEL[zk]} ${zoneState(sh.zones[zk])}`).join(' · ')}</small></div>
        <button class="btn" data-act="repair" ${!cost || s.gold < cost ? 'disabled' : ''}>${cost ? `Réparer · ${fmt(cost)} or` : 'En état'}</button></div><h3>Améliorations</h3>` +
        Object.entries(UPGRADES).map(([k, u]) => {
          const t = s.up[k], c = P.upgradeCost(k), ok = c && s.gold >= c[0] && s.planks >= c[1];
          return `<div class="line"><div><b>${u.name} <span class="pips">${[0, 1, 2].map((i) => `<i class="${i < t ? 'on' : ''}"></i>`).join('')}</span></b><small>${u.desc}${c ? ` · prochain rang : ${u.tiers[t]}` : ' · rang maximal'}</small></div>
          <button class="btn ${ok ? '' : 'ghost'}" data-act="upgrade" data-arg="${k}" ${ok ? '' : 'disabled'}>${c ? `${fmt(c[0])} or · ${c[1]} planches` : 'Maximum'}</button></div>`;
        }).join('');
    } else if (portTab === 'primes') {
      const b = s.bounty, act = BOUNTIES.find((q) => q.id === b.active);
      body = `<h3>Prime en cours</h3>${act ? `<div class="line"><div><b>${act.text}</b><small>${b.done ? 'Accomplie' : `${b.prog} / ${act.n}`} · ${fmt(act.gold)} or, ${act.xp} XP</small></div><div class="row">${b.done ? '<button class="btn" data-act="claim">Toucher la prime</button>' : '<button class="btn ghost" data-act="dropb">Abandonner</button>'}</div></div>` : '<p class="note">Aucune. Une prime donne une direction à la sortie ; une seule à la fois.</p>'}
        <h3>Tableau</h3>` + b.offers.filter((id) => id !== b.active).map((id) => {
          const q = BOUNTIES.find((z) => z.id === id);
          return `<div class="line"><div><b>${q.text}</b><small>${fmt(q.gold)} or · ${q.xp} XP${q.final ? ' · objectif final, niveau 5 conseillé' : ''}</small></div><button class="btn ghost" data-act="accept" data-arg="${id}" ${act ? 'disabled' : ''}>Accepter</button></div>`;
        }).join('');
    } else {
      const x = P.xpInfo(), pl = G.player;
      body = `<h3>Capitaine, niveau ${s.level}</h3><div class="bar big"><i style="width:${Math.round(x.f * 100)}%"></i></div><p class="note">${x.next ? `${x.next} XP avant le niveau ${s.level + 1}` : 'Niveau maximal'} · vie ${pl.maxHp} · endurance ${pl.maxSt} · dégâts +${Math.round((pl.dmgMul - 1) * 100)} %</p>
        <h3>Actions</h3>${Object.entries(UNLOCKS).map(([l, n]) => `<div class="line"><div><b>${n}</b><small>${n === 'Parade' ? 'Bloque de face ; au bon moment, elle étourdit l’attaquant' : n === 'Coup lourd' ? 'Lent, coûteux en endurance, fait chanceler les brutes' : 'Viser plus d’une seconde : la balle traverse'}</small></div><span class="${s.level >= l ? 'ok' : 'lock'}">${s.level >= l ? 'Acquis' : `Niveau ${l}`}</span></div>`).join('')}
        <h3>Journal</h3><p class="note">${s.stats.sorties} sorties · ${s.stats.sunk} navires coulés · ${s.stats.kills} ennemis abattus · ${fmt(s.stats.gold)} or gagné${s.doneFinal ? ' · fort pris' : ''}</p>`;
    }
    return `<p class="eyebrow">Port-Liberté · partie sauvegardée</p>${head()}<div class="tabs">${tabs.map(([k, n]) => `<button class="${portTab === k ? 'on' : ''}" data-act="tab" data-arg="${k}">${n}</button>`).join('')}</div><div class="body">${body}</div><div class="row end"><button class="btn" data-act="close">Reprendre la mer</button></div>`;
  },
};

let panelArg = null;
const render = () => {
  el.panel.innerHTML = `<div class="sheet ${panel}">${R[panel](panelArg)}</div>`;
  if (panel === 'map') drawMap($('bigmap'), true);
};
export const openPanel = (name, arg) => {
  panel = name; panelArg = arg; confirmNew = false;
  if (name !== 'title') G.mode = 'panel';
  G.ambient = name === 'port' || name === 'title';
  el.panel.hidden = false;
  el.hud.classList.toggle('dim', true);
  if (document.pointerLockElement) document.exitPointerLock();
  render();
};
export const closePanel = () => {
  if (panel === 'title') return;
  panel = null; el.panel.hidden = true; el.hud.classList.remove('dim');
  G.mode = 'play'; G.ambient = false;
  requestLock();
};

const act = (a, arg) => {
  const s = G.save;
  sfx('ui');
  if (a === 'close') return closePanel();
  if (a === 'tab') portTab = arg;
  else if (a === 'sell') { const v = P.sellAll(); if (v) toast(`Butin vendu : ${fmt(v)} or`); }
  else if (a === 'planks') P.buyPlanks(+arg);
  else if (a === 'repair') P.repairShip();
  else if (a === 'upgrade') P.buyUpgrade(arg);
  else if (a === 'accept') P.acceptBounty(arg);
  else if (a === 'dropb') P.dropBounty();
  else if (a === 'claim') P.claimBounty();
  else if (a === 'map') return openPanel('map');
  else if (a === 'quality') { s.opts.quality = +arg; emit('quality', {}); P.writeSave(); }
  else if (a === 'sound') { s.opts.sound = arg === '1'; setSound(s.opts.sound); P.writeSave(); }
  else if (a === 'sens') { s.opts.sens = +arg; P.writeSave(); }
  else if (a === 'fs') { try { const r = document.documentElement.requestFullscreen(); if (r && r.catch) r.catch(() => toast('Plein écran indisponible ici')); if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) { toast('Plein écran indisponible ici'); } }
  else if (a === 'asknew') confirmNew = true;
  else if (a === 'new' || a === 'continue') { initAudio(); panel = null; el.panel.hidden = true; el.hud.classList.remove('dim'); G.ambient = false; emit('start', { fresh: a === 'new' }); return; }
  else if (a === 'totitle') { panel = null; emit('toTitle', {}); return; }
  render();
};

// ----- construction -----
const TB = [
  ['atk', 'Sabre', 'foot big'], ['roll', 'Esquive', 'foot'], ['jump', 'Saut', 'foot'], ['gun', 'Tir', 'foot'], ['parry', 'Parade', 'foot l2'], ['heavy', 'Lourd', 'foot l3'],
  ['fireL', 'Bâbord', 'helm big'], ['fireR', 'Tribord', 'helm big'], ['sailUp', '▲', 'helm'], ['sailDown', '▼', 'helm'], ['shot', 'Coque', 'helm'],
];
export const initHud = (root) => {
  root.insertAdjacentHTML('beforeend', `
  <div id="hud" hidden>
    <div id="tl"><div class="lvl"><small>niv.</small><b id="lvl">1</b></div><div class="bars"><div class="bar hp"><i id="hp"></i></div><div class="bar st"><i id="st"></i></div><div class="bar xp"><i id="xp"></i></div><div id="ammo"></div></div></div>
    <div id="tr"><div class="res"><b id="gold">0</b> or<span class="sep"></span><b id="cargo">0/12</b> cale<span class="sep"></span><b id="planks">0</b> pl.</div><canvas id="mini" width="280" height="280"></canvas><div id="bounty"></div></div>
    <button id="bpause" aria-label="Pause">II</button>
    <div id="banner"><h2></h2><p></p></div>
    <div id="boss" hidden><span></span><div class="bar"><i></i></div></div>
    <div id="shipbox" hidden>
      <svg viewBox="0 0 60 110" aria-hidden="true"><path id="z-bow" d="M30 3 C42 16 48 26 49 36 L11 36 C12 26 18 16 30 3Z"/><path id="z-star" d="M32 38 L49 38 L50 84 L32 84Z"/><path id="z-port" d="M11 38 L28 38 L28 84 L10 84Z"/><path id="z-stern" d="M10 86 L50 86 L46 106 L14 106Z"/><circle id="z-mast" cx="30" cy="58" r="7"/></svg>
      <div class="sb"><div class="bar hull"><i id="hull"></i></div><div class="sl"><span id="sails"><i></i><i></i><i></i></span><b id="knots">0</b> nœuds</div><div id="shotl">Coque</div></div>
    </div>
    <div id="hints"></div>
    <div id="prompt" hidden><span></span><i></i></div>
    <div id="toasts"></div>
    <div id="cross" hidden><i></i></div>
    <div id="nums"></div>
    <div id="vig"></div>
    <div id="touch" hidden><div id="joy"><i></i></div>${TB.map(([n, l, c]) => `<button class="tb ${c}" id="tb-${n}" data-tb="${n}"><span>${l}</span><em></em></button>`).join('')}<button class="tb use" id="tb-use" data-tb="use" hidden><span></span></button></div>
  </div>
  <div id="panel" hidden></div>
  <div id="fade"><p></p></div>`);
  ['hud', 'hp', 'st', 'xp', 'lvl', 'ammo', 'gold', 'cargo', 'planks', 'mini', 'bounty', 'banner', 'boss', 'shipbox', 'hull', 'sails', 'knots', 'shotl', 'hints', 'prompt', 'toasts', 'cross', 'nums', 'vig', 'touch', 'joy', 'panel', 'fade', 'bpause'].forEach((k) => { el[k] = $(k); });
  G.numsEl = el.nums;
  buildMap();
  el.panel.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) act(b.dataset.act, b.dataset.arg); });
  el.bpause.addEventListener('click', () => { if (G.mode === 'play') openPanel('pause'); });
  el.mini.addEventListener('click', () => { if (G.mode === 'play') openPanel('map'); });
  el.touch.querySelectorAll('[data-tb]').forEach((b) => {
    const n = b.dataset.tb;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); b.setPointerCapture(e.pointerId); touchBtn(n, true); b.classList.add('down'); });
    const up = (e) => { e.preventDefault(); touchBtn(n, false); b.classList.remove('down'); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  });
  on('toast', ({ text, key }) => toast(text, key));
  on('banner', ({ title, sub }) => banner(title, sub));
  on('fade', fade);
  on('openPort', ({ tab }) => { portTab = tab; openPanel('port'); });
  on('pause', () => { if (G.mode === 'play') openPanel('pause'); });
  on('victory', (a) => openPanel('victory', a));
  on('hurt', () => { el.vig.classList.remove('hit'); void el.vig.offsetWidth; el.vig.classList.add('hit'); });
  on('labels', () => { last.hints = null; if (panel) render(); });
  on('touchMode', () => { last.hints = null; if (panel) render(); });
};
export const showHud = (v) => { el.hud.hidden = !v; };

export const updateHud = () => {
  const p = G.player, s = G.ship, sv = G.save, inp = G.input;
  if (inp.pause && G.mode === 'play') return openPanel('pause');
  if (inp.map && G.mode === 'play') return openPanel('map');
  const helm = p.mode === 'helm';
  width('hp', el.hp, p.hp / p.maxHp); width('st', el.st, p.st / p.maxSt); width('xp', el.xp, P.xpInfo().f);
  set('lvl', el.lvl, sv.level);
  const am = p.ammo + ':' + (p.reloadT > 0 ? 1 : 0);
  if (last.ammo !== am) { last.ammo = am; el.ammo.innerHTML = Array.from({ length: 8 }, (_, i) => `<i class="${i < p.ammo ? 'on' : ''}"></i>`).join('') + (p.reloadT > 0 ? '<span>recharge</span>' : ''); }
  set('gold', el.gold, fmt(sv.gold)); set('cargo', el.cargo, `${P.cargoCount()}/${P.capacity()}`); set('planks', el.planks, sv.planks);
  const b = sv.bounty, def = BOUNTIES.find((q) => q.id === b.active);
  set('bounty', el.bounty, def ? (b.done ? `Prime accomplie : rentre au port` : `${def.text} · ${b.prog}/${def.n}`) : 'Aucune prime : tableau du port');
  // navire
  const showShip = p.aboard;
  if (last.showShip !== showShip) { last.showShip = showShip; el.shipbox.hidden = !showShip; }
  if (showShip) {
    ZONES.forEach((zk) => { const z = s.zones[zk], st = z.dead ? 'dead' : z.hp < z.max * 0.6 ? 'dmg' : 'ok'; if (last['z' + zk] !== st) { last['z' + zk] = st; $('z-' + zk).setAttribute('class', st); } });
    width('hull', el.hull, s.hull / s.hullMax);
    set('knots', el.knots, knots(s).toFixed(1).replace('.', ','));
    if (last.sail !== s.sail) { last.sail = s.sail; el.sails.querySelectorAll('i').forEach((n, i) => n.classList.toggle('on', i < s.sail)); }
    set('shotl', el.shotl, s.shot === 'hull' ? 'Vise la coque' : 'Vise les voiles');
  }
  // invite d'action
  const pr = G.prompt, key = pr ? pr.text + (pr.hold ? 'h' : '') : '';
  if (last.prompt !== key) {
    last.prompt = key;
    el.prompt.hidden = !pr || G.isTouch || helm;
    if (pr) el.prompt.querySelector('span').innerHTML = `${kb('KeyE')} ${pr.hold ? 'maintenir · ' : ''}${pr.text}`;
    const u = $('tb-use'); u.hidden = !pr; if (pr) u.querySelector('span').textContent = pr.text;
  }
  if (pr) el.prompt.querySelector('i').style.width = Math.round((pr.prog || 0) * 100) + '%';
  // boss
  const bs = G.boss;
  if (last.boss !== !!bs) { last.boss = !!bs; el.boss.hidden = !bs; if (bs) el.boss.querySelector('span').textContent = bs.def.name; }
  if (bs) el.boss.querySelector('i').style.width = Math.round(clamp(bs.hp / bs.maxHp, 0, 1) * 100) + '%';
  const cr = p.aiming;
  if (last.cross !== cr) { last.cross = cr; el.cross.hidden = !cr; }
  if (cr) el.cross.classList.toggle('charged', p.lvl >= 5 && p.aimT > 1.3);
  // aide clavier et boutons tactiles selon le mode
  const hk = (G.isTouch ? 't' : 'k') + (helm ? 'h' : p.aboard ? 'd' : 'f') + sv.level + (s.moored ? 'm' : '');
  if (last.hints !== hk) {
    last.hints = hk;
    el.touch.hidden = !G.isTouch; el.hints.hidden = G.isTouch;
    el.touch.classList.toggle('helm', helm);
    $('tb-parry').hidden = sv.level < 2; $('tb-heavy').hidden = sv.level < 3;
    el.hints.innerHTML = helm
      ? `${kb('KeyW')}${kb('KeyS')} voiles · ${kb('KeyA')}${kb('KeyD')} barre · <b>clic</b> bordée du côté regardé · ${kb('KeyR')} coque/voiles · ${kb('KeyE')} lâcher la barre`
      : `${kb('KeyW')}${kb('KeyA')}${kb('KeyS')}${kb('KeyD')} bouger · <b>clic</b> sabre · <b>clic droit</b> viser · ${kb('ShiftLeft')} esquive · ${kb('Space')} saut${sv.level >= 2 ? ` · ${kb('KeyQ')} parade` : ''}${sv.level >= 3 ? ` · ${kb('KeyF')} lourd` : ''}`;
  }
  if (G.isTouch) {
    const j = inputState.joy, on2 = j.id !== null;
    if (last.joyOn !== on2) { last.joyOn = on2; el.joy.classList.toggle('on', on2); if (on2) { el.joy.style.left = j.ox + 'px'; el.joy.style.top = j.oy + 'px'; } }
    if (on2) el.joy.firstChild.style.transform = `translate(${j.x * 40}px, ${j.y * 40}px)`;
    if (helm) {
      [['fireL', 1, 'port'], ['fireR', -1, 'star']].forEach(([n, sd, zk]) => {
        const f = s.zones[zk].dead ? 1 : clamp(s.reload[sd] / (s.sp.reload / s.reloadMul), 0, 1), v = Math.round(f * 20);
        if (last['r' + n] !== v) { last['r' + n] = v; $('tb-' + n).querySelector('em').style.height = v * 5 + '%'; $('tb-' + n).classList.toggle('off', s.zones[zk].dead); }
      });
      set('tbshot', $('tb-shot').querySelector('span'), s.shot === 'hull' ? 'Coque' : 'Voiles');
    } else set('tbgun', $('tb-gun').querySelector('span'), p.reloadT > 0 ? '…' : 'Tir');
  }
  if (mapFrame++ % 4 === 0) drawMap(el.mini, false);
};
