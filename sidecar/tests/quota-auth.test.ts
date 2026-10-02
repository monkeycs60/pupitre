import { expect, test } from 'bun:test'
import { macAuthScript, quotaAuthCommand } from '../src/quota-auth'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('associe chaque provider à sa commande de connexion interactive', () => {
  expect(quotaAuthCommand('claude', {})).toEqual(['claude', 'auth', 'login'])
  expect(quotaAuthCommand('codex', {})).toEqual(['codex', 'login'])
  expect(quotaAuthCommand('grok', {})).toEqual(['grok', 'login', '--oauth'])
})

test('le terminal Mac transmet les arguments littéraux et conserve le code de sortie', () => {
  const directory = mkdtempSync(join(tmpdir(), "pupitre login ' "))
  try {
    const status = join(directory, 'status')
    const script = join(directory, 'login.command')
    const argument = "a'b $(echo INJECTION) ; spaces"
    writeFileSync(script, macAuthScript(['bash', '-c', 'printf "%s" "$1"; exit 7', '--', argument], status, process.env.PATH!))
    const child = Bun.spawnSync(['bash', script])
    expect(child.stdout.toString()).toBe(argument)
    expect(child.exitCode).toBe(7)
    expect(readFileSync(status, 'utf8')).toBe('7')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
