import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { killGroup, spawnGroup } from './process-group'

export type PromotionStateName = 'idle' | 'running' | 'done' | 'failed'
export type PromotionStepStatus = 'running' | 'done' | 'failed'
export interface PromotionEvent {
  step: string
  status: PromotionStepStatus
  message: string
  at?: string
  sha?: string
  activity?: Record<string, unknown>
}
export interface PromotionState {
  state: PromotionStateName
  sha: string | null
  startedAt: string | null
  finishedAt: string | null
  steps: Record<string, PromotionStepStatus>
  events: PromotionEvent[]
}

export class PromotionConflictError extends Error {}

export class PromotionRunner {
  private child: ChildProcess | null = null
  private cancelled = false
  private current: PromotionState = {
    state: 'idle', sha: null, startedAt: null, finishedAt: null, steps: {}, events: [],
  }

  snapshot(): PromotionState {
    return structuredClone(this.current)
  }

  start(options: { force?: boolean; timeoutMinutes?: number; skipBuild?: boolean }): PromotionState {
    if (this.current.state === 'running') throw new PromotionConflictError('une promotion est déjà en cours')
    const root = join(import.meta.dir, '..', '..')
    const script = process.env.PUPITRE_PROMOTE_SCRIPT ?? join(root, 'scripts', 'promote.ts')
    const args = ['run', script, '--json']
    if (options.force) args.push('--force')
    if (options.skipBuild) args.push('--skip-build')
    if (options.timeoutMinutes !== undefined) args.push('--timeout', String(options.timeoutMinutes))
    this.cancelled = false
    this.current = {
      state: 'running', sha: null, startedAt: new Date().toISOString(), finishedAt: null, steps: {}, events: [],
    }
    const child = spawnGroup('bun', args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => this.acceptLine(line))
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (message) this.pushEvent({ step: 'promotion', status: 'running', message })
    })
    child.once('close', (code) => {
      this.child = null
      if (this.cancelled) return
      this.current.state = code === 0 ? 'done' : 'failed'
      this.current.finishedAt = new Date().toISOString()
      if (code !== 0 && !this.current.events.some((event) => event.status === 'failed')) {
        this.pushEvent({ step: 'promotion', status: 'failed', message: `promotion terminée avec le code ${code}` })
      }
    })
    return this.snapshot()
  }

  cancel(): PromotionState {
    if (this.current.state !== 'running' || !this.child) return this.snapshot()
    const step = [...this.current.events].reverse().find((event) => event.status === 'running')?.step
    if (step === 'switch' || step === 'launch') throw new PromotionConflictError('bascule en cours')
    this.cancelled = true
    killGroup(this.child)
    this.current.state = 'failed'
    this.current.finishedAt = new Date().toISOString()
    this.pushEvent({ step: 'promotion', status: 'failed', message: 'promotion annulée' })
    return this.snapshot()
  }

  async stableHealth(): Promise<unknown> {
    const origin = process.env.PUPITRE_STABLE_ORIGIN ?? 'http://127.0.0.1:4820'
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) })
      return response.ok ? response.json() : { running: false }
    } catch {
      return { running: false }
    }
  }

  private acceptLine(line: string): void {
    try {
      const event = JSON.parse(line) as PromotionEvent
      if (typeof event.step !== 'string' || typeof event.status !== 'string' || typeof event.message !== 'string') return
      this.pushEvent(event)
    } catch {}
  }

  private pushEvent(event: PromotionEvent): void {
    this.current.events = [...this.current.events, event].slice(-500)
    this.current.steps[event.step] = event.status
    if (event.sha) this.current.sha = event.sha
  }
}
