import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installBrowserSkill, linkIfAbsent } from './setup-browser'

test('installe le skill pour les deux agents et conserve une configuration personnelle', () => {
  const home = mkdtempSync(join(tmpdir(), 'pupitre-browser test-'))
  try {
    const existing = join(home, '.claude/skills/agent-browser')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'SKILL.md'), 'personnel')
    const directory = join(home, '.local/opt/pupitre-browser/test')
    installBrowserSkill(home, directory)
    installBrowserSkill(home, directory)
    expect(readFileSync(join(existing, 'SKILL.md'), 'utf8')).toBe('personnel')
    expect(realpathSync(join(home, '.codex/skills/agent-browser'))).toBe(realpathSync(join(directory, 'skill')))
    expect(realpathSync(join(home, '.agents/skills/agent-browser'))).toBe(realpathSync(join(directory, 'skill')))
    expect(realpathSync(join(home, '.local/bin/ab'))).toBe(realpathSync(join(directory, 'skill/scripts/ab')))
    const dangling = join(home, 'custom-ab')
    symlinkSync(join(home, 'missing'), dangling)
    expect(linkIfAbsent('replacement', dangling)).toBe(false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('le wrapper utilise le même onglet, transmet les arguments littéraux et ne ferme pas Chrome', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pupitre-ab test-'))
  try {
    const fake = join(directory, 'fake-browser')
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const wrapper = join(import.meta.dir, '../setup/agent-browser/scripts/ab')
    const env = { ...process.env, AGENT_BROWSER_BIN: fake, AB_SESSION: 'conversation-1', AB_RELAY: '' }
    const run = (args: string[], overrides = {}) => Bun.spawnSync(['bash', wrapper, ...args], { env: { ...env, ...overrides } })
    const url = "https://example.com/?x=$(literal)&name=l'ami"
    expect(run(['open', url]).stdout.toString().trim().split('\n')).toEqual(['--session', 'pupitre-conversation-1', '--pin-tab', '--auto-connect', 'open', url])
    expect(run(['close']).stdout.toString()).toEndWith('tab\nclose\n')
    expect(run(['close', '--all']).exitCode).toBe(2)
    expect(run(['snapshot'], { AB_RELAY: 'ws://127.0.0.1:9333/test' }).stdout.toString()).toContain('--cdp\nws://127.0.0.1:9333/test\n')
    expect(run(['snapshot'], { AB_SESSION: '', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: 'codex-thread' }).stdout.toString()).toContain('pupitre-codex-thread')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
