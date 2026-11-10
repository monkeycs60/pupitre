export const title = async ({ page, shot }) => { await shot('title'); };
export const start = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(3000);
  await shot('start');
  console.log(await ev(() => { const { G } = window.__pirate; const p = G.player; return JSON.stringify({ mode: G.mode, pm: p.mode, x: p.x, y: p.y, z: p.z, ship: [G.ship.x, G.ship.z, G.ship.th], ships: G.ships.length }); }));
};
const info = (ev) => ev(() => { const { G } = window.__pirate; const p = G.player, s = G.ship; return JSON.stringify({ mode: G.mode, pm: p.mode, p: [p.x, p.y, p.z].map((v) => +v.toFixed(1)), l: [+p.lx.toFixed(2), +p.lz.toFixed(2)], hp: Math.round(p.hp), ship: [s.x, s.z, s.th, s.speed].map((v) => +v.toFixed(1)), sail: s.sail, moored: s.moored && s.moored.id, prompt: G.prompt && G.prompt.text, hull: Math.round(s.hull), zones: Object.fromEntries(Object.entries(s.zones).map(([k, z]) => [k, Math.round(z.hp)])) }); });
const sim = (ev, n) => ev((n) => window.__pirate.sim(n), n);
export const board = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(500);
  const t0 = Date.now(); await page.waitForTimeout(2000);
  console.log('fps~', await ev(() => new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t > 1500) r((n / 1.5).toFixed(1)); else requestAnimationFrame(f); }; f(); })));
  await page.keyboard.down('KeyS');
  for (let i = 0; i < 14; i++) { await sim(ev, 30); if (i % 3 === 0) console.log(await info(ev)); }
  await page.keyboard.up('KeyS');
  await page.waitForTimeout(600); await shot('board1');
  console.log(await info(ev));
};
const tap = async (page, ev, code, n = 2) => { await page.keyboard.down(code); await sim(ev, n); await page.keyboard.up(code); await sim(ev, 1); };
const toHelm = async (page, ev) => {
  await ev(() => { const { G, toDeck } = window.__pirate; toDeck(G.player, G.ship.model.helm.x, G.ship.model.helm.z); });
  await sim(ev, 2); await tap(page, ev, 'KeyE');
};
export const sail = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  await toHelm(page, ev);
  console.log(await info(ev));
  for (let i = 0; i < 3; i++) await tap(page, ev, 'KeyW');
  await sim(ev, 240);
  console.log(await info(ev));
  await page.waitForTimeout(700); await shot('sail1');
  await page.keyboard.down('KeyA'); await sim(ev, 150); await page.keyboard.up('KeyA');
  console.log(await info(ev));
  await page.waitForTimeout(700); await shot('sail2');
  // regarder à bâbord : arc de tir
  await ev(() => { window.__pirate.G.cam.rel = 1.5; window.__pirate.G.cam.pitch = 0.45; });
  await sim(ev, 30); await page.waitForTimeout(700); await shot('sail3');
};
const foe = (ev, i = 1) => ev((i) => { const { G } = window.__pirate; const s = G.ships[i]; return JSON.stringify({ kind: s.kind, alive: s.alive, st: s.ai.state, pos: [s.x, s.z, s.th, s.speed].map((v) => +v.toFixed(1)), hull: Math.round(s.hull), zones: Object.fromEntries(Object.entries(s.zones).map(([k, z]) => [k, Math.round(z.hp)])), d: +Math.hypot(s.x - G.ship.x, s.z - G.ship.z).toFixed(0) }); }, i);
export const naval = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  await toHelm(page, ev);
  // se placer à 55 m par le travers d'un sloop, lui à tribord
  await ev(() => { const { G } = window.__pirate; const e = G.ships[1], s = G.ship; s.th = e.th; s.x = e.x + Math.cos(e.th) * 55; s.z = e.z - Math.sin(e.th) * 55; s.sail = 2; s.vx = e.vx; s.vz = e.vz; G.cam.rel = -1.5; G.cam.pitch = 0.4; });
  await sim(ev, 20);
  console.log(await info(ev)); console.log(await foe(ev));
  for (let k = 0; k < 6; k++) {
    await page.mouse.move(640, 300); await page.mouse.down(); await sim(ev, 2); await page.mouse.up();
    await sim(ev, 20);
    if (k === 0) { await page.waitForTimeout(600); await shot('naval1'); }
    await sim(ev, 150);
    console.log(await foe(ev));
  }
  console.log(await info(ev));
  await page.waitForTimeout(600); await shot('naval2');
  console.log(await ev(() => { const { G } = window.__pirate; return JSON.stringify({ xp: G.save.xp, lvl: G.save.level, cargo: G.save.cargo, planks: G.save.planks, stats: G.save.stats }); }));
};
const foes = (ev) => ev(() => { const { G } = window.__pirate; const p = G.player; return JSON.stringify(G.enemies.map((e) => `${e.type}:${e.alive ? Math.round(e.hp) : 'x'}:${e.state}:${Math.hypot(e.x - p.x, e.z - p.z).toFixed(0)}m`)) + ' hp=' + Math.round(p.hp) + ' st=' + Math.round(p.st) + ' act=' + p.act + ' xp=' + G.save.xp + ' carried=' + G.sortie.carried.length + ' ammo=' + p.ammo; });
const land = (ev, i, camp) => ev(([i, camp]) => { const { G, islands, placeAtDock, toWorld } = window.__pirate; const isl = islands[i]; placeAtDock(G.ship, isl); const c = isl.camps[camp]; const k = isl.dock; toWorld(G.player, c.x + k.ux * 13, c.z + k.uz * 13, k.a + Math.PI); G.cam.yaw = k.a + Math.PI; G.cam.pitch = 0.3; }, [i, camp]);
export const fight = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  await land(ev, 1, 0);
  await sim(ev, 40);
  console.log(await foes(ev));
  await page.waitForTimeout(600); await shot('fight0');
  await page.mouse.move(640, 300);
  for (let k = 0; k < 14; k++) {
    await page.mouse.down(); await sim(ev, 2); await page.mouse.up(); await sim(ev, 10);
    if (k === 3) { await page.waitForTimeout(500); await shot('fight1'); }
    if (k % 3 === 2) console.log(await foes(ev));
  }
  await page.waitForTimeout(500); await shot('fight2');
  await sim(ev, 200);
  console.log(await foes(ev));
  console.log(await info(ev));
};
export const ui = async ({ page, shot, ev }) => {
  await shot('ui-title');
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  await ev(() => { const { G, emit } = window.__pirate; G.save.gold = 520; G.save.cargo = { rhum: 3, soie: 2, perles: 1 }; G.ship.zones.port.hp = 20; G.ship.hull = 180; emit('openPort', { tab: 'marchand' }); });
  await page.waitForTimeout(400); await shot('ui-marchand');
  for (const t of ['chantier', 'primes', 'capitaine']) { await page.click(`[data-act="tab"][data-arg="${t}"]`); await page.waitForTimeout(250); await shot('ui-' + t); }
  await page.click('[data-act="tab"][data-arg="primes"]'); await page.click('[data-act="accept"]');
  await page.click('[data-act="tab"][data-arg="marchand"]'); await page.click('[data-act="sell"]');
  await page.click('[data-act="tab"][data-arg="chantier"]'); await page.click('[data-act="repair"]'); await page.click('[data-act="upgrade"][data-arg="hold"]');
  console.log(await ev(() => { const { G } = window.__pirate; return JSON.stringify({ gold: G.save.gold, up: G.save.up, planks: G.save.planks, bounty: G.save.bounty, hull: G.ship.hull, cargo: G.save.cargo }); }));
  await page.click('[data-act="close"]');
  await page.keyboard.press('KeyM'); await sim(ev, 2); await page.waitForTimeout(400); await shot('ui-map');
};
export const mobile = async ({ page, shot, ev }) => {
  await shot('m-title');
  await page.tap('[data-act="new"]');
  await page.waitForTimeout(300); await sim(ev, 10);
  await page.waitForTimeout(500); await shot('m-foot');
  await ev(() => { const { G } = window.__pirate; G.save.level = 3; window.__pirate.P.applyLevel(); });
  await toHelmTouch(page, ev);
  await ev(() => { const { G } = window.__pirate; G.ship.sail = 3; });
  await sim(ev, 200);
  await page.waitForTimeout(500); await shot('m-helm');
  console.log(await info(ev));
};
const toHelmTouch = async (page, ev) => {
  await ev(() => { const { G, toDeck } = window.__pirate; toDeck(G.player, G.ship.model.helm.x, G.ship.model.helm.z); });
  await sim(ev, 3);
  await page.tap('#tb-use'); await sim(ev, 3);
};
export const smoke = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  // --- mousquet, esquive, parade, coup lourd sur l'île 2 (brute) ---
  await ev(() => { const { G, P } = window.__pirate; G.save.level = 5; G.save.xp = 380; P.applyLevel(); G.player.hp = G.player.maxHp; });
  await land(ev, 2, 0); await sim(ev, 30);
  console.log('ile2', await foes(ev));
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' }); await sim(ev, 12);
  await ev(() => { const { G } = window.__pirate; const p = G.player, e = G.enemies.find((q) => q.type === 'brute'); G.cam.yaw = Math.atan2(e.x - p.x, e.z - p.z); G.cam.pitch = Math.atan2(p.y + 1.6 - (e.y + 1.1 * e.scale), Math.hypot(e.x - p.x, e.z - p.z)); });
  await sim(ev, 3); await page.waitForTimeout(400); await shot('aim');
  await page.mouse.down(); await sim(ev, 2); await page.mouse.up(); await sim(ev, 4);
  await page.mouse.up({ button: 'right' });
  console.log('après tir', await foes(ev));
  await page.keyboard.down('ShiftLeft'); await sim(ev, 2); await page.keyboard.up('ShiftLeft'); await sim(ev, 6);
  console.log('roulade', await ev(() => { const p = window.__pirate.G.player; return p.act + ' st=' + Math.round(p.st) + ' reload=' + p.reloadT.toFixed(1); }));
  await sim(ev, 25);
  await page.keyboard.down('KeyQ'); await sim(ev, 60);
  console.log('parade', await foes(ev));
  await page.keyboard.up('KeyQ');
  for (let k = 0; k < 10; k++) { await page.keyboard.down('KeyF'); await sim(ev, 2); await page.keyboard.up('KeyF'); await sim(ev, 34); }
  console.log('lourds', await foes(ev));
  await page.waitForTimeout(400); await shot('brute');
  // --- mort à pied ---
  await ev(() => { const { G } = window.__pirate; G.sortie.carried = ['rhum', 'soie']; G.player.hp = 1; G.player.iframes = 0; });
  await sim(ev, 400);
  await page.waitForTimeout(3500); await sim(ev, 10);
  console.log('mort', await info(ev), await ev(() => window.__pirate.G.sortie.carried.length));
  // --- coffre ---
  await ev(() => { const { G, islands, toWorld } = window.__pirate; const c = islands[2].chestList[0]; toWorld(G.player, c.x + 1.5, c.z, 0); G.enemies.forEach((e) => { e.alive && (e.hp = 0.1); }); });
  await page.keyboard.down('KeyE'); await sim(ev, 40); await page.keyboard.up('KeyE');
  console.log('coffre', await ev(() => { const { G, islands } = window.__pirate; return JSON.stringify({ open: islands[2].chestList[0].open, carried: G.sortie.carried, planks: G.save.planks }); }));
  // --- réparation sur le pont, puis naufrage ---
  await ev(() => { const { G, toDeck } = window.__pirate; const s = G.ship; s.zones.port.hp = 10; const r = s.model.repair.port; toDeck(G.player, r.x - 0.5, r.z); window.__pirate.emit('boarded', {}); });
  await page.keyboard.down('KeyE'); await sim(ev, 90); await page.keyboard.up('KeyE');
  console.log('réparé', await info(ev), await ev(() => JSON.stringify(window.__pirate.G.save.cargo)));
  await page.waitForTimeout(400); await shot('repair');
  await ev(() => { const { G } = window.__pirate; G.ship.moored = null; G.ship.x += 200; G.save.gold = 300; G.ship.hull = 1; G.ship.zones.port.hp = 0; G.ship.zones.port.dead = true; });
  await sim(ev, 150);
  await page.waitForTimeout(1500); await shot('sink');
  await page.waitForTimeout(4500); await sim(ev, 10);
  console.log('naufrage', await info(ev), await ev(() => JSON.stringify({ gold: window.__pirate.G.save.gold, cargo: window.__pirate.G.save.cargo, ships: window.__pirate.G.ships.length })));
};
export const boss = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  await ev(() => { const { G, P } = window.__pirate; G.save.level = 8; G.save.xp = 1300; P.applyLevel(); G.player.hp = G.player.maxHp; P.acceptBounty('fort'); });
  await land(ev, 3, 1); await sim(ev, 30);
  console.log('fort', await foes(ev));
  await page.waitForTimeout(400); await shot('fort0');
  await page.mouse.move(640, 360);
  let done = false;
  for (let k = 0; k < 40 && !done; k++) {
    await ev(() => { const { G } = window.__pirate; G.player.hp = G.player.maxHp; G.enemies.forEach((e) => { if (e.alive && e.type !== 'capitaine') e.hp = Math.min(e.hp, 10); else if (e.alive) e.hp = Math.min(e.hp, 420); }); });
    await page.mouse.down(); await sim(ev, 2); await page.mouse.up(); await sim(ev, 13);
    if (k === 6) { await page.waitForTimeout(400); await shot('fort1'); }
    if (k % 8 === 7) console.log(await foes(ev));
    done = await ev(() => !window.__pirate.G.enemies.some((e) => e.type === 'capitaine' && e.alive));
  }
  console.log('fin', await foes(ev));
  await sim(ev, 100); await page.waitForTimeout(600); await shot('victory');
  console.log(await ev(() => JSON.stringify({ mode: window.__pirate.G.mode, bounty: window.__pirate.G.save.bounty, done: window.__pirate.G.save.doneFinal, panel: document.querySelector('#panel .sheet') && document.querySelector('#panel .sheet').className })));
};
export const moor = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  await toHelm(page, ev);
  // arriver vers le ponton de l'île aux Tortues à petite vitesse puis lâcher la barre
  await ev(() => { const { G, islands } = window.__pirate; const isl = islands[1], k = isl.dock, s = G.ship; const d = k.s1 + 22; s.x = isl.x + k.ux * d - k.tx * 30; s.z = isl.z + k.uz * d - k.tz * 30; s.th = Math.atan2(k.tx, k.tz); s.sail = 1; });
  await sim(ev, 150);
  console.log(await info(ev));
  await tap(page, ev, 'KeyE'); await sim(ev, 120);
  console.log(await info(ev));
  await page.waitForTimeout(500); await shot('moor');
  // marcher vers la passerelle et descendre
  const side = await ev(() => window.__pirate.G.ship.moorPose.side);
  await ev((side) => { const { G, toDeck } = window.__pirate; toDeck(G.player, side * 1.5, 0); G.cam.yaw = G.ship.th + side * Math.PI / 2; }, side);
  await page.keyboard.down('KeyW'); await sim(ev, 150); await page.keyboard.up('KeyW');
  console.log(await info(ev));
  await page.waitForTimeout(500); await shot('landed');
};
export const boss2 = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  await ev(() => { const { G, P } = window.__pirate; G.save.level = 8; G.save.xp = 1300; P.applyLevel(); G.player.hp = G.player.maxHp; P.acceptBounty('fort'); });
  await land(ev, 3, 1); await sim(ev, 5);
  await ev(() => { const { G } = window.__pirate; G.enemies.forEach((e) => { if (e.type !== 'capitaine') e.hp = 0.01; else e.hp = 300; }); });
  await page.mouse.move(640, 360);
  const dbg = () => ev(() => { const { G } = window.__pirate; const p = G.player, e = G.enemies.find((q) => q.type === 'capitaine'); return JSON.stringify({ p: [p.x, p.y, p.z, p.yaw].map((v) => +v.toFixed(1)), pm: p.mode, act: p.act, actT: +p.actT.toFixed(2), hp: Math.round(p.hp), st: Math.round(p.st), e: e && [e.x, e.y, e.z].map((v) => +v.toFixed(1)), ehp: e && Math.round(e.hp), es: e && e.state, eact: e && e.act, cd: e && +e.cd.toFixed(1), stag: e && +e.stag.toFixed(1), phase: e && e.phase, n: G.enemies.length, mode: G.mode }); });
  for (let k = 0; k < 60; k++) {
    await ev(() => { const { G } = window.__pirate; G.player.hp = G.player.maxHp; G.enemies.forEach((e) => { if (e.alive && e.type !== 'capitaine') e.hp = 0.01; }); });
    await page.mouse.down(); await sim(ev, 2); await page.mouse.up(); await sim(ev, 13);
    if (k % 8 === 0) console.log(await dbg());
    if (await ev(() => !window.__pirate.G.enemies.some((e) => e.type === 'capitaine' && e.alive))) break;
  }
  await sim(ev, 100); await page.waitForTimeout(600); await shot('victory');
  console.log(await ev(() => JSON.stringify({ mode: window.__pirate.G.mode, bounty: window.__pirate.G.save.bounty, done: window.__pirate.G.save.doneFinal, panel: document.querySelector('#panel .sheet') && document.querySelector('#panel .sheet').className })));
};
export const misc = async ({ page, shot, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300); await sim(ev, 5);
  await page.keyboard.press('Escape'); await sim(ev, 2); await page.waitForTimeout(300); await shot('pause');
  await page.click('[data-act="quality"][data-arg="0"]'); await page.click('[data-act="quality"][data-arg="2"]');
  await page.click('[data-act="totitle"]'); await page.waitForTimeout(300); await shot('title2');
  await page.click('[data-act="continue"]'); await page.waitForTimeout(300); await sim(ev, 5);
  console.log('reprise', await info(ev));
  // caisses d'épave et prime
  await ev(() => { const { G, P } = window.__pirate; P.acceptBounty('epaves'); });
  await toHelm(page, ev);
  for (const i of [0, 1, 2]) {
    await ev((i) => { const { G } = window.__pirate; const s = G.ship; const w = [[215, -150], [-200, -235], [170, -570]][i]; s.x = w[0] + 12; s.z = w[1]; s.vx = s.vz = 0; s.sail = 1; }, i);
    await sim(ev, 200);
  }
  console.log('épaves', await ev(() => { const { G } = window.__pirate; return JSON.stringify({ cargo: G.save.cargo, planks: G.save.planks, bounty: G.save.bounty }); }));
  // longue durée : 12 minutes de mer, le joueur au large ; les navires ne doivent ni s'échouer ni dérailler
  await ev(() => { const { G, islands, placeAtDock, toDeck } = window.__pirate; placeAtDock(G.ship, islands[3]); toDeck(G.player, 0, 2); });
  for (let k = 0; k < 8; k++) {
    await ev(() => window.__pirate.sim(3600, 1 / 30));
    console.log(await ev(() => { const { G } = window.__pirate; return JSON.stringify(G.ships.map((s) => `${s.kind[0]}:${s.alive ? '' : 'X'}${s.ai ? s.ai.state.slice(0, 4) : 'me'}:${Math.round(s.x)},${Math.round(s.z)}:h${Math.round(s.hull)}`)) + ' me.hull=' + Math.round(G.ship.hull) + ' hp=' + Math.round(G.player.hp) + ' mode=' + G.mode; }));
  }
};
export const gal = async ({ page, ev }) => {
  await page.click('[data-act="new"]');
  await page.waitForTimeout(300);
  for (let k = 0; k < 10; k++) {
    await ev(() => window.__pirate.sim(450, 1 / 30));
    console.log(await ev(() => { const s = window.__pirate.G.ships[6]; return JSON.stringify({ pos: [Math.round(s.x), Math.round(s.z)], th: +s.th.toFixed(2), sp: +s.speed.toFixed(1), sail: s.sail, rud: +s.rudder.toFixed(2), helm: s.helm, ai: { st: s.ai.state, wp: s.ai.wp, av: s.ai.av, stuck: +(s.ai.stuck || 0).toFixed(1), free: +(s.ai.free || 0).toFixed(1) } }); }));
  }
};
