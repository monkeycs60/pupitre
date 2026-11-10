// Toutes les données de jeu sont ici : ennemis, navires, butin, améliorations, primes, carte.
// Ajouter du contenu = ajouter une ligne, sans toucher au code des systèmes.

export const SHIPS = {
  player: {
    label: 'Sloop', L: 24, B: 7, deckY: 1.6, draft: 1.9, qh: 1.0,
    masts: [{ u: 0.56, h: 17 }], cannons: 4, sail: 'cream', hullCol: 0x7a5232, trim: 0x1f4a66, deckCol: 0xb89462,
    hull: 300, zone: 100, speed: 13.5, turn: 0.62, dmg: 22, reload: 4.5,
  },
  sloop: {
    label: 'Sloop', L: 21, B: 6.2, deckY: 1.5, draft: 1.7, qh: 0.9,
    masts: [{ u: 0.56, h: 15 }], cannons: 3, sail: 'red', hullCol: 0x5d3b28, trim: 0x8e2a22, deckCol: 0xa58258,
    hull: 190, zone: 70, speed: 11.5, turn: 0.58, dmg: 11, reload: 6.5, xp: 60,
  },
  galion: {
    label: 'Galion', L: 38, B: 10.5, deckY: 2.6, draft: 2.8, qh: 1.9,
    masts: [{ u: 0.27, h: 20 }, { u: 0.5, h: 26 }, { u: 0.74, h: 21 }], cannons: 6, sail: 'black', hullCol: 0x3b2a22, trim: 0xb8912f, deckCol: 0x8f7350,
    hull: 600, zone: 150, speed: 8.2, turn: 0.33, dmg: 15, reload: 8, xp: 160,
  },
};

export const ZONES = ['bow', 'port', 'star', 'stern', 'mast'];
export const ZONE_LABEL = { bow: 'Proue', port: 'Flanc bâbord', star: 'Flanc tribord', stern: 'Poupe', mast: 'Mâts' };
export const ZONE_MALUS = { bow: 'éperon inefficace', port: 'canons bâbord hors service, voie d’eau', star: 'canons tribord hors service, voie d’eau', stern: 'maniabilité réduite', mast: 'vitesse réduite' };
export const SAIL_LABEL = ['Voiles carguées', 'Petite toile', 'Demi-toile', 'Toutes voiles'];

export const PLAYER = {
  hp: 100, stamina: 100, staminaRegen: 24, ammoMax: 8,
  run: 6.2, slow: 2.6, jump: 6.6, gravity: 19,
  light: [18, 18, 28], heavy: 48, musket: 70, charged: 125,
  rollCost: 22, heavyCost: 26, parryHit: 18, parryDrain: 7,
  reload: 2.5, reach: 2.5,
};

export const FOES = {
  bretteur: { name: 'Bretteur', hp: 55, speed: 5.2, dmg: 11, xp: 12, scale: 1.0, weapon: 'saber', coat: 0x8b2f2a, pants: 0x3b3a44, hat: 'bandana', hatCol: 0xb5382f },
  tireur: { name: 'Tireur', hp: 40, speed: 4.2, dmg: 18, xp: 14, scale: 0.98, weapon: 'musket', coat: 0x2f5d7a, pants: 0xd8cfb8, hat: 'tricorn', hatCol: 0x22262b },
  brute: { name: 'Brute', hp: 170, speed: 3.1, dmg: 34, xp: 30, scale: 1.3, bulk: 1.35, weapon: 'club', coat: 0x5a4632, pants: 0x2d2a26, hat: 'none', hatCol: 0 },
  boucher: { name: 'Le Boucher', hp: 380, speed: 3.3, dmg: 40, xp: 120, scale: 1.55, bulk: 1.4, weapon: 'club', coat: 0x7a1f1f, pants: 0x1f1c1a, hat: 'bandana', hatCol: 0x111111, boss: 'mini' },
  capitaine: { name: 'Capitaine du fort', hp: 760, speed: 4.6, dmg: 15, xp: 400, scale: 1.16, bulk: 1.1, weapon: 'saber', coat: 0x1c2f5e, pants: 0xe6dfc9, hat: 'captain', hatCol: 0x14161c, boss: 'final' },
};

export const LOOT = {
  rhum: { name: 'Rhum', v: 15 },
  epices: { name: 'Épices', v: 30 },
  soie: { name: 'Soieries', v: 50 },
  perles: { name: 'Perles', v: 90 },
  idole: { name: 'Idole d’or', v: 220 },
};
// tables de butin : [objet, poids]
export const DROPS = {
  foe: [['rhum', 6], ['epices', 3], ['soie', 1]],
  brute: [['epices', 4], ['soie', 3], ['perles', 1]],
  chest1: [['rhum', 3], ['epices', 4], ['soie', 2]],
  chest2: [['epices', 2], ['soie', 4], ['perles', 3]],
  chest3: [['soie', 2], ['perles', 4], ['idole', 2]],
  wreck: [['rhum', 4], ['epices', 3], ['soie', 2], ['perles', 1]],
  sloop: [['rhum', 3], ['epices', 4], ['soie', 2]],
  galion: [['soie', 3], ['perles', 4], ['idole', 1]],
};

export const LEVELS = [0, 40, 110, 220, 380, 600, 900, 1300, 1800, 2400];
export const UNLOCKS = { 2: 'Parade', 3: 'Coup lourd', 5: 'Tir chargé' };

export const UPGRADES = {
  hull: { name: 'Coque', desc: 'Résistance de la coque et des zones', tiers: ['+25 %', '+50 %', '+80 %'], mult: [1, 1.25, 1.5, 1.8] },
  sails: { name: 'Voiles', desc: 'Vitesse maximale', tiers: ['+10 %', '+20 %', '+30 %'], mult: [1, 1.1, 1.2, 1.3] },
  cannons: { name: 'Canons', desc: 'Dégâts et recharge des bordées', tiers: ['+20 %', '+40 %', '+65 %'], mult: [1, 1.2, 1.4, 1.65] },
  hold: { name: 'Cale', desc: 'Capacité de butin', tiers: ['18', '26', '36'], mult: [12, 18, 26, 36] },
};
export const UP_COST = [[150, 6], [400, 14], [900, 28]]; // [or, planches] par rang
export const PLANK_PRICE = 10;

export const BOUNTIES = [
  { id: 'sloops', text: 'Couler 2 sloops', ev: 'sunk', match: 'sloop', n: 2, gold: 130, xp: 60 },
  { id: 'plage', text: 'Nettoyer la plage de l’Île aux Tortues', ev: 'cleared', match: 'ile1:plage', n: 1, at: 'ile1', gold: 100, xp: 50 },
  { id: 'epaves', text: 'Fouiller 3 épaves', ev: 'wreck', match: '', n: 3, gold: 120, xp: 40 },
  { id: 'coffres', text: 'Ouvrir 4 coffres', ev: 'chest', match: '', n: 4, gold: 130, xp: 50 },
  { id: 'tireurs', text: 'Abattre 5 tireurs', ev: 'kill', match: 'tireur', n: 5, gold: 140, xp: 60 },
  { id: 'galion', text: 'Couler un galion', ev: 'sunk', match: 'galion', n: 1, gold: 280, xp: 150 },
  { id: 'boucher', text: 'Abattre Le Boucher sur l’Île du Crâne', ev: 'kill', match: 'boucher', n: 1, at: 'ile2', gold: 320, xp: 180 },
  { id: 'fort', text: 'Prendre le Fort de la Couronne : tuer son capitaine', ev: 'kill', match: 'capitaine', n: 1, at: 'fort', gold: 1000, xp: 500, final: true },
];

// Carte : le nord est vers -z. af = fraction du rayon vers le ponton, ac = mètres en travers.
export const ISLANDS = [
  {
    id: 'port', name: 'Port-Liberté', sub: 'Base sûre', x: 0, z: 0, r: 105, hillK: 5, hillAmp: 3, seed: 3.1, p1: 0.4, p2: 1.9, dock: Math.PI,
    safe: true, palms: 26, rocks: 8, camps: [], chests: [],
    flats: [{ af: 0.6, ac: 0, r: 30 }],
  },
  {
    id: 'ile1', name: 'Île aux Tortues', sub: 'Zone de départ', x: 430, z: -330, r: 115, hillK: 6, hillAmp: 4, seed: 9.7, p1: 2.2, p2: 0.3, dock: -0.92,
    palms: 46, rocks: 16,
    flats: [{ af: 0.62, ac: 6, r: 20 }, { af: 0.05, ac: -18, r: 22 }],
    camps: [
      { id: 'plage', af: 0.62, ac: 6, weak: true, foes: ['bretteur', 'bretteur', 'tireur'] },
      { id: 'camp', af: 0.05, ac: -18, weak: true, foes: ['bretteur', 'bretteur', 'tireur', 'tireur'] },
    ],
    chests: [{ af: 0.5, ac: 22, tier: 1 }, { af: 0.02, ac: -30, tier: 1 }, { af: -0.5, ac: 20, tier: 1 }],
  },
  {
    id: 'ile2', name: 'Île du Crâne', sub: 'Zone avancée', x: -470, z: -450, r: 145, hillK: 8, hillAmp: 5, seed: 21.3, p1: 5.1, p2: 3.3, dock: 0.81,
    palms: 60, rocks: 26,
    flats: [{ af: 0.6, ac: -8, r: 20 }, { af: 0.12, ac: 38, r: 24 }, { af: -0.38, ac: -18, r: 24 }],
    camps: [
      { id: 'guet', af: 0.6, ac: -8, foes: ['brute', 'bretteur', 'bretteur'] },
      { id: 'village', af: 0.12, ac: 38, foes: ['tireur', 'tireur', 'bretteur', 'bretteur', 'brute'] },
      { id: 'antre', af: -0.38, ac: -18, foes: ['boucher', 'bretteur', 'tireur'] },
    ],
    chests: [{ af: 0.52, ac: -26, tier: 2 }, { af: 0.1, ac: 54, tier: 2 }, { af: -0.42, ac: -34, tier: 3 }, { af: -0.1, ac: -60, tier: 2 }],
  },
  {
    id: 'fort', name: 'Fort de la Couronne', sub: 'Objectif final', x: 40, z: -930, r: 96, hillK: 6, hillAmp: 2, seed: 33.9, p1: 1.1, p2: 4.4, dock: 0,
    palms: 10, rocks: 30, fort: true,
    flats: [{ af: 0, ac: 0, r: 42, h: 5 }],
    camps: [
      { id: 'cour', af: 0.1, ac: 0, foes: ['bretteur', 'bretteur', 'tireur', 'tireur', 'brute'] },
      { id: 'donjon', af: -0.1, ac: 0, foes: ['capitaine'] },
    ],
    chests: [{ af: -0.16, ac: 15, tier: 3 }, { af: -0.16, ac: -15, tier: 3 }],
  },
];

export const WRECKS = [
  { x: 215, z: -150 }, { x: -200, z: -235 }, { x: 170, z: -570 }, { x: -260, z: -720 }, { x: 540, z: -650 },
];

// Navires ennemis : routes fixes (patrouille) ou poste fixe (repos).
export const FLEET = [
  { kind: 'sloop', route: [[300, -130], [560, -180], [600, -480], [330, -560], [220, -330]] },
  { kind: 'sloop', route: [[-190, -200], [-280, -290], [-120, -430], [70, -310]] },
  { kind: 'sloop', route: [[150, -590]] },
  { kind: 'sloop', route: [[560, -670]] },
  { kind: 'galion', route: [[-240, -330], [-330, -690], [-690, -620], [-700, -330], [-470, -210]] },
  { kind: 'galion', route: [[210, -770], [40, -690], [-130, -770]] },
];

export const WORLD = { cx: 0, cz: -450, radius: 1050, safeR: 250, wind: 0.6 };
