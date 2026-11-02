// Mesure la voie rapide de Jarvis sur de vraies conversations, face à Haiku 5.5.
//
//   bun run measure:jarvis-search --dataset /chemin/hors-du-depot.json [--haiku] [--db pupitre.db] [--out resultats.json]
//
// Le jeu de mesure reste hors du dépôt : il cite des conversations personnelles.
// [{ "q": "où on a parlé du délai", "kind": "sens", "expect": ["1a2b3c4d"] }, ...]
// `expect` : préfixes d'identifiants acceptés ; [] si aucune conversation ne traite le sujet ;
// absent si la demande n'est pas une recherche et doit aller à Claude.
import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeJarvisGenerator, claudeJarvisPrewarm, JarvisService, type JarvisGenerator, type JarvisJob } from '../sidecar/src/jarvis'
import { jevRouter, type JarvisRouter } from '../sidecar/src/jarvis-router'
import { QuotaTracker } from '../sidecar/src/quotas'
import { ConversationStore } from '../sidecar/src/stores/conversations'
import { ProjectStore } from '../sidecar/src/stores/projects'

interface Query { q: string; kind: string; expect?: string[] }

const PRICE_PER_TOKEN = 0.042 / 1_000_000

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

const datasetPath = argument('dataset')
if (!datasetPath) throw new Error('--dataset requis : voir l’en-tête du script.')
const dataset = await Bun.file(datasetPath).json() as Query[]
const source = argument('db') ?? join(homedir(), '.local/share/pupitre/pupitre.db')

function apiKey(): string | null {
  const environment = process.env.JEV_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim()
  if (environment) return environment
  const settings = new Database(source, { readonly: true })
  try {
    const row = settings.query('SELECT value FROM settings WHERE key = ?').get('integrationTokens') as { value: string } | null
    return row ? (JSON.parse(row.value) as Record<string, string>).typesafe ?? null : null
  } finally {
    settings.close()
  }
}
const key = apiKey()
if (!key) throw new Error('Clé TypeSafe absente : Réglages › Tokens d’intégration, ou JEV_API_KEY.')

// Une copie : la mesure ne touche jamais à la base en service.
const copy = join(tmpdir(), `jarvis-search-${process.pid}.db`)
const original = new Database(source, { readonly: true })
original.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
original.close()
const db = new Database(copy)
db.query('DELETE FROM settings WHERE key = ?').run('integrationTokens')
const projects = new ProjectStore(db)
const conversations = new ConversationStore(db)
const titleOf = (id: string) => (db.query('SELECT title FROM conversations WHERE id = ?').get(id) as { title: string } | null)?.title ?? id
const base = { db, projects, conversations, fleet: () => [], runningApplications: () => [] }

let tokens = 0
const counting: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const response = await fetch(input, init)
  const body = await response.clone().json().catch(() => null) as { usage?: { input_tokens?: number } } | null
  tokens += body?.usage?.input_tokens ?? 0
  return response
}, fetch)
const jev = jevRouter(() => key, counting)
let probabilities: { search: number; plan: number; best: number | null; none: number | null } = { search: 0, plan: 0, best: null, none: null }
const router: JarvisRouter = {
  ready: jev.ready,
  async decide(input) {
    const verdict = await jev.decide(input)
    probabilities = { search: verdict.searchProbability, plan: verdict.probability, best: null, none: null }
    return verdict
  },
  async choose(input) {
    const choice = await jev.choose(input)
    probabilities.best = choice.ranking[0]?.probability ?? null
    probabilities.none = choice.none
    return choice
  },
}

async function finished(service: JarvisService, question: string, mode: 'auto' | 'fast'): Promise<{ job: JarvisJob; ms: number }> {
  const started = performance.now()
  const { id } = service.ask({ question, projectId: null, conversationId: null, history: [], mode, shortcut: null })
  for (;;) {
    const job = service.get(id)!
    if (job.status !== 'running') return { job, ms: Math.round(performance.now() - started) }
    await Bun.sleep(5)
  }
}

function verdict(query: Query, ids: string[], answered: boolean): string {
  if (!answered) return query.expect === undefined ? 'bien envoyée à Claude' : 'relue par Claude'
  if (query.expect === undefined) return 'FAUSSE RECHERCHE'
  if (query.expect.length === 0) return ids.length === 0 ? 'rien, à raison' : 'FAUX POSITIF'
  if (ids.length === 0) return 'RIEN À TORT'
  return query.expect.some((prefix) => ids[0]!.startsWith(prefix)) ? 'juste' : 'FAUX'
}

function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0
}

function tally(rows: Array<{ verdict: string }>): string {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1)
  return [...counts].map(([name, count]) => `${name} ${count}`).join(' · ')
}

// Claude n'est pas appelé ici : on note seulement que la demande lui serait revenue.
const noClaude: JarvisGenerator = async () => JSON.stringify({ text: 'relue par Claude', results: [], actions: [] })
const auto = new JarvisService({ ...base, generate: noClaude, router })
const jevRows = []
for (const query of dataset) {
  tokens = 0
  const { job, ms } = await finished(auto, query.q, 'auto')
  const answered = job.route?.model === 'jev'
  const ids = answered ? job.answer!.results.map((result) => result.conversationId) : []
  const row = { q: query.q, kind: query.kind, ms, tokens, ...probabilities, verdict: verdict(query, ids, answered), results: ids.map(titleOf) }
  jevRows.push(row)
  console.log(`${String(ms).padStart(5)} ms ${row.verdict.padEnd(22)} recherche ${row.search} choix ${row.best ?? '–'} aucune ${row.none ?? '–'} | ${query.q.slice(0, 60)}${row.results[0] ? ` → ${row.results[0]}` : ''}`)
}

const haikuRows = []
if (process.argv.includes('--haiku')) {
  const haiku = new JarvisService({ ...base, generate: claudeJarvisGenerator(new QuotaTracker(db)), prewarm: claudeJarvisPrewarm() })
  for (const query of dataset.filter((item) => item.expect !== undefined)) {
    haiku.warm(null, 'fast')
    await Bun.sleep(3_000)
    const { job, ms } = await finished(haiku, query.q, 'fast')
    const ids = job.answer?.results.map((result) => result.conversationId) ?? []
    const row = { q: query.q, kind: query.kind, ms, status: job.status, verdict: verdict(query, ids, true), results: ids.map(titleOf), text: job.answer?.text ?? job.error }
    haikuRows.push(row)
    console.log(`${String(ms).padStart(5)} ms ${row.verdict.padEnd(22)} Haiku | ${query.q.slice(0, 60)}${row.results[0] ? ` → ${row.results[0]}` : ''}`)
  }
}

const answeredRows = jevRows.filter((row) => row.best !== null)
console.log(`\nJev : ${tally(jevRows)}`)
console.log(`Durée de bout en bout, demandes tranchées par Jev : médiane ${percentile(answeredRows.map((row) => row.ms), 0.5)} ms, 90 % sous ${percentile(answeredRows.map((row) => row.ms), 0.9)} ms`)
console.log(`Coût : ${percentile(answeredRows.map((row) => row.tokens), 0.5)} jetons par recherche, ${(percentile(answeredRows.map((row) => row.tokens), 0.5) * PRICE_PER_TOKEN).toFixed(5)} $`)
if (haikuRows.length > 0) {
  console.log(`Haiku : ${tally(haikuRows)}`)
  console.log(`Durée : médiane ${percentile(haikuRows.map((row) => row.ms), 0.5)} ms, 90 % sous ${percentile(haikuRows.map((row) => row.ms), 0.9)} ms`)
}
const out = argument('out')
if (out) await Bun.write(out, JSON.stringify({ jev: jevRows, haiku: haikuRows }, null, 2))

db.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
process.exit(0)
