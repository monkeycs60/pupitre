import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromotionConflictError, PromotionRunner } from '../src/promotion'

const dirs: string[] = []
afterEach(() => {
  delete process.env.PUPITRE_PROMOTE_SCRIPT
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function script(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pupitre-promotion-'))
  dirs.push(dir)
  const path = join(dir, 'promote.ts')
  writeFileSync(path, source)
  return path
}

async function waitFinished(runner: PromotionRunner) {
  const deadline = Date.now() + 3_000
  while (runner.snapshot().state === 'running' && Date.now() < deadline) await Bun.sleep(20)
  return runner.snapshot()
}

test('conserve les événements dans l’ordre puis termine', async () => {
  process.env.PUPITRE_PROMOTE_SCRIPT = script(`
console.log(JSON.stringify({step:'build',status:'running',message:'build'}))
console.log(JSON.stringify({step:'build',status:'done',message:'ok',sha:'abc'}))
console.log(JSON.stringify({step:'verify',status:'done',message:'vérifié'}))
`)
  const runner = new PromotionRunner()
  runner.start({})
  const state = await waitFinished(runner)
  expect(state.state).toBe('done')
  expect(state.events.map((event) => event.step)).toEqual(['build', 'build', 'verify'])
  expect(state.steps).toEqual({ build: 'done', verify: 'done' })
})

test('un script en erreur marque la promotion en échec', async () => {
  process.env.PUPITRE_PROMOTE_SCRIPT = script('process.exit(1)')
  const runner = new PromotionRunner()
  runner.start({})
  expect((await waitFinished(runner)).state).toBe('failed')
})

test('refuse une seconde promotion pendant la première', async () => {
  process.env.PUPITRE_PROMOTE_SCRIPT = script('await Bun.sleep(500)')
  const runner = new PromotionRunner()
  runner.start({})
  expect(() => runner.start({})).toThrow(PromotionConflictError)
  runner.cancel()
  await waitFinished(runner)
})
