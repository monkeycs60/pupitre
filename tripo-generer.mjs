// Génère les modèles Tripo du jeu pirate et les range dans ./assets/*.glb
// Usage (Node 18+, aucune dépendance) :
//   TRIPO_API_KEY=tsk_xxx node tripo-generer.mjs            -> tout le lot
//   TRIPO_API_KEY=tsk_xxx node tripo-generer.mjs palmier coffre   -> seulement ces modèles
// Les fichiers déjà présents sont conservés : relancer ne refacture pas ce qui existe.
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';

const BASE = process.env.TRIPO_BASE || 'https://openapi.tripo3d.com/v3';
const KEY = process.env.TRIPO_API_KEY;
const OUT = 'assets';
const MODEL = 'v3.1-20260211';

// Une seule planche de style pour tout le lot : c'est elle qui tient la cohérence.
const STYLE = 'stylized low poly game asset, simple chunky shapes, flat colors, short warm palette, no text, single object centered, clean silhouette';

// faces = budget de triangles (génération légère pour le temps réel)
const ASSETS = [
  { name: 'palmier', faces: 3000, prompt: 'a tropical palm tree with curved trunk and coconuts' },
  { name: 'rocher', faces: 1200, prompt: 'a large weathered grey beach boulder' },
  { name: 'coffre', faces: 2500, prompt: 'a closed wooden pirate treasure chest with brass bands and a lock' },
  { name: 'caisse', faces: 1000, prompt: 'a wooden cargo crate with rope' },
  { name: 'tonneau', faces: 1500, prompt: 'a wooden rum barrel with iron hoops' },
  { name: 'tente', faces: 2000, prompt: 'a small canvas camp tent of a pirate crew' },
  { name: 'maison', faces: 5000, prompt: 'a small caribbean harbor house with red tiled roof, door and shutters' },
  { name: 'etal', faces: 4000, prompt: 'a wooden market stall with striped cloth awning and goods on the counter' },
  { name: 'phare', faces: 5000, prompt: 'a red and white striped lighthouse on a stone base' },
  { name: 'epave', faces: 5000, prompt: 'a broken shipwreck hull half sunk with a snapped mast and torn sail' },
  { name: 'pirate', faces: 9000, prompt: 'a pirate captain full body, standing in A-pose with arms slightly apart, blue coat, black tricorn hat, short beard, boots, empty hands' },
  { name: 'sloop', faces: 16000, prompt: 'a single-masted pirate sloop sailing ship with square sail, jib, bowsprit, eight cannons, open main deck, seen whole' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
const api = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 0) throw new Error(`${path} -> HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json.data;
};

const generate = async (a, log) => {
  const file = `${OUT}/${a.name}.glb`;
  if (await exists(file)) { console.log(`= ${a.name} : déjà là, conservé`); return; }
  // reprise : si une tâche a déjà été lancée pour ce modèle, on la suit au lieu d'en payer une autre
  let id = log[a.name];
  if (!id) {
    const d = await api('/generation/text-to-model', {
      prompt: `${a.prompt}, ${STYLE}`, model: MODEL, texture: true, pbr: false, texture_quality: 'standard',
      smart_low_poly: true, face_limit: a.faces, auto_size: true,
    });
    id = d.task_id;
    log[a.name] = id;
    await writeFile(`${OUT}/taches.json`, JSON.stringify(log, null, 2));
    console.log(`+ ${a.name} : tâche ${id}`);
  }
  for (let i = 0; i < 180; i++) {
    await sleep(5000);
    const t = await api(`/tasks/${id}`);
    if (t.status === 'success') {
      const out = t.output || {};
      const url = out.model_url || Object.values(out).find((v) => typeof v === 'string' && /\.glb(\?|$)/.test(v));
      if (!url) throw new Error(`${a.name} : pas de fichier GLB dans la réponse ${JSON.stringify(out).slice(0, 200)}`);
      const bin = await fetch(url);
      if (!bin.ok) throw new Error(`${a.name} : téléchargement refusé (HTTP ${bin.status})`);
      const buf = Buffer.from(await bin.arrayBuffer());
      await writeFile(file, buf);
      console.log(`✓ ${a.name} : ${(buf.length / 1048576).toFixed(1)} Mo${t.credits_consumed ? `, ${t.credits_consumed} crédits` : ''}`);
      return;
    }
    if (['failed', 'cancelled', 'banned', 'expired'].includes(t.status)) { delete log[a.name]; await writeFile(`${OUT}/taches.json`, JSON.stringify(log, null, 2)); throw new Error(`${a.name} : tâche ${t.status}`); }
    if (i % 6 === 5) console.log(`  ${a.name} : ${t.status} ${t.progress ?? ''}%`);
  }
  throw new Error(`${a.name} : toujours en cours après 15 min (relance le script, la tâche sera reprise)`);
};

const main = async () => {
  if (!KEY) { console.error('Il manque la clé : TRIPO_API_KEY=tsk_... node tripo-generer.mjs'); process.exit(1); }
  await mkdir(OUT, { recursive: true });
  const log = JSON.parse(await readFile(`${OUT}/taches.json`, 'utf8').catch(() => '{}'));
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((n) => !ASSETS.some((a) => a.name === n));
  if (unknown.length) { console.error(`Modèle inconnu : ${unknown.join(', ')}. Disponibles : ${ASSETS.map((a) => a.name).join(', ')}`); process.exit(1); }
  const list = ASSETS.filter((a) => !wanted.length || wanted.includes(a.name));
  const failed = [];
  // trois tâches de front : assez pour aller vite sans se faire limiter
  let next = 0;
  const worker = async () => { while (next < list.length) { const a = list[next++]; try { await generate(a, log); } catch (e) { failed.push(a.name); console.error(`✗ ${e.message}`); } } };
  await Promise.all([worker(), worker(), worker()]);
  console.log(failed.length ? `\nÉchecs : ${failed.join(', ')}. Relance : node tripo-generer.mjs ${failed.join(' ')}` : `\nTout est dans ./${OUT}. Zippe le dossier et envoie-le dans la conversation.`);
  process.exit(failed.length ? 2 : 0);
};
main();
