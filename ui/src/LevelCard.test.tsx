import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen, fireEvent } = await import('@testing-library/react')
const { LevelCard } = await import('./LevelCard')
const type = await import('./types')

afterEach(cleanup)

const HOUR = 3_600_000

function counter(ms: number): type.TimeCounter {
  return {
    ms,
    level: Math.floor(ms / HOUR),
    levelMs: ms % HOUR,
    progress: (ms % HOUR) / HOUR,
    todayMs: 33 * 60_000,
  }
}

function snapshot(overrides: Partial<type.TimeSnapshot> = {}): type.TimeSnapshot {
  return {
    scope: 'project',
    projectId: 'p1',
    projectCount: 1,
    user: counter(HOUR + 19 * 60_000),
    agent: counter(22 * 60_000),
    supervisionMs: 20 * 60_000,
    writingMs: 59 * 60_000,
    agentAloneMs: 2 * 60_000,
    weekUserMs: 0,
    weekAgentMs: 0,
    previousWeekUserMs: 0,
    activeDays: 3,
    commits: 0,
    turnCount: 0,
    backfilledMs: 0,
    nextMilestone: 10,
    msToNextMilestone: 0,
    milestones: [],
    projects: [],
    conversations: {},
    turns: {},
    ...overrides,
  }
}

function card() {
  return document.querySelector('.level-card') as HTMLElement
}

test('au repos, la carte ne montre que le niveau, le mode et le temps du jour', () => {
  render(
    <LevelCard snapshot={snapshot()} mode="user" agentRunning={false} onToggle={() => undefined} />,
  )
  expect(card().dataset.mode).toBe('user')
  expect(screen.getByText('Utilisateur')).toBeTruthy()
  expect(document.querySelector('.level-ring-value')?.textContent).toBe('1')
  expect(document.querySelector('.level-today')?.textContent).toContain('33 min')
  // Le détail n'apparaît qu'au survol.
  expect(document.querySelector('.level-share')).toBeNull()
})

test('la barre avance d’un cran par minute, jamais entre deux', () => {
  // 1 h 19 min 45 s : la barre doit afficher 19 minutes, pas 19,75.
  const almost = counter(HOUR + 19 * 60_000 + 45_000)
  render(
    <LevelCard snapshot={snapshot({ user: almost })} mode="user" agentRunning={false} onToggle={() => undefined} />,
  )
  const fill = document.querySelector('.level-bar-fill') as HTMLElement
  expect(fill.style.width).toBe(`${(19 / 60) * 100}%`)
})

test('le survol révèle la part de supervision, et rien d’autre', () => {
  render(
    <LevelCard snapshot={snapshot()} mode="user" agentRunning={false} onToggle={() => undefined} />,
  )
  fireEvent.mouseEnter(card())
  expect(document.querySelector('.level-share')?.textContent).toContain('supervisé')
  // La pastille d'échange a été retirée : le clic sur la carte suffit.
  expect(document.querySelector('.level-swap')).toBeNull()
  fireEvent.mouseLeave(card())
  expect(document.querySelector('.level-share')).toBeNull()
})

test('le clic bascule sur le compteur agent', () => {
  let toggles = 0
  const { rerender } = render(
    <LevelCard snapshot={snapshot()} mode="user" agentRunning={false} onToggle={() => { toggles += 1 }} />,
  )
  fireEvent.click(card())
  expect(toggles).toBe(1)
  rerender(
    <LevelCard snapshot={snapshot()} mode="agent" agentRunning={false} onToggle={() => undefined} />,
  )
  expect(card().dataset.mode).toBe('agent')
  expect(screen.getByText('Agent')).toBeTruthy()
  // 22 minutes d'agent : niveau 0, barre au tiers.
  expect(document.querySelector('.level-ring-value')?.textContent).toBe('0')
  expect((document.querySelector('.level-bar-fill') as HTMLElement).style.width).toBe(`${(22 / 60) * 100}%`)
})

test('sans projet sélectionné, la carte annonce sa portée globale', () => {
  render(
    <LevelCard
      snapshot={snapshot({ scope: 'global', projectId: null, projectCount: 3 })}
      mode="user"
      agentRunning={false}
      onToggle={() => undefined}
    />,
  )
  expect(document.querySelector('.level-scope')?.textContent).toBe('3 projets')
})

test('un tour en cours s’annonce sans changer de compteur', () => {
  render(
    <LevelCard snapshot={snapshot()} mode="user" agentRunning onToggle={() => undefined} />,
  )
  expect(document.querySelector('.level-running')?.textContent).toContain('agent')
  expect(document.querySelector('.level-ring-value')?.textContent).toBe('1')
})
