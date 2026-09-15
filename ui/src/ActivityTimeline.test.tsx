import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ActivityReportProject } from './api'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render } = await import('@testing-library/react')
const { ActivityTimeline, commitRadius, ticketColors, timelineWindow } = await import('./ActivityTimeline')

afterEach(cleanup)

const DAY = '2026-09-15'
const at = (hour: number, minute = 0) => {
  const date = new Date(`${DAY}T00:00:00`)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

function project(overrides: Partial<ActivityReportProject> = {}): ActivityReportProject {
  return {
    projectId: 'p', projectName: 'Pupitre', userMs: 0, agentMs: 0, linesAdded: 0, linesRemoved: 0, unlinkedCommitCount: 0,
    topics: [], conversations: [], commits: [], tickets: [], mergeRequests: [], ticketsReady: [], todosDone: [],
    timeline: { presence: [{ from: at(9), to: at(10, 30), ticketKey: 'TECH-1' }, { from: at(14), to: at(15) }], agent: [{ from: at(9, 5), to: at(9, 20) }], turns: [at(9, 3), at(14, 10)] },
    ...overrides,
  }
}

test('la fenêtre couvre 8 h à 20 h et s’élargit à l’heure ronde autour d’un commit tardif', () => {
  const base = timelineWindow(DAY, [project()])
  expect(new Date(base.startMs).getHours()).toBe(8)
  expect(new Date(base.endMs).getHours()).toBe(20)
  const late = timelineWindow(DAY, [project({ commits: [{ sha: 'a', repositoryPath: '.', branch: 'master', subject: 'tard', productMessage: null, linesAdded: 1, linesRemoved: 0, committedAt: at(21, 30), conversationId: null }] })])
  expect(new Date(late.endMs).getHours()).toBe(22)
  expect(commitRadius(0)).toBe(3)
  expect(commitRadius(10_000)).toBe(7)
})

test('rend une voie par projet avec présence, agent, tours, commits, MR et tickets prêts', () => {
  const projects = [
    project({
      commits: [
        { sha: 'a', repositoryPath: '.', branch: 'master', subject: 'lié', productMessage: null, linesAdded: 10, linesRemoved: 2, committedAt: at(10), conversationId: 'c1' },
        { sha: 'b', repositoryPath: '.', branch: 'origin/master', subject: 'seul', productMessage: null, linesAdded: 1, linesRemoved: 0, committedAt: at(16), conversationId: null },
      ],
      mergeRequests: [{ ref: 'reactor!1', iid: 1, project: 'reactor', title: 'MR', url: 'https://git/1', state: 'opened', ticketKey: 'TECH-1', createdAt: at(11) }],
      ticketsReady: [{ ticketId: 't', key: 'TECH-1', title: 'Prêt', externalUrl: 'https://clickup/t', toStatus: 'ready for production', changedAt: at(17) }],
    }),
    project({ projectId: 'q', projectName: 'Perso', timeline: { presence: [], agent: [], turns: [] } }),
  ]
  const opened: string[] = []
  const { container } = render(createElement(ActivityTimeline, { day: DAY, projects, onOpenConversation: (_p, id) => opened.push(id) }))
  expect(container.querySelectorAll('.activity-timeline-row')).toHaveLength(2)
  expect(container.querySelectorAll('.activity-lane .activity-lane-presence')).toHaveLength(2)
  expect(container.querySelectorAll('.activity-lane .activity-lane-agent')).toHaveLength(1)
  expect(container.querySelectorAll('.activity-lane .activity-lane-turn')).toHaveLength(2)
  expect(container.querySelectorAll('.activity-lane .activity-lane-commit')).toHaveLength(2)
  expect(container.querySelectorAll('.activity-lane a.activity-lane-mr')).toHaveLength(1)
  expect(container.querySelectorAll('.activity-lane a.activity-lane-ready')).toHaveLength(1)
  const presence = container.querySelector<HTMLElement>('.activity-lane .activity-lane-presence')!
  expect(presence.style.left).toBe('8.333%')
  expect(presence.style.width).toBe('12.500%')
  const linked = container.querySelector<HTMLButtonElement>('button.activity-lane-commit')!
  expect(linked.title).toContain('lié')
  linked.click()
  expect(opened).toEqual(['c1'])
  expect(container.querySelector('.activity-lane-commit.is-unlinked')?.getAttribute('title')).toContain('poussé')
  const tinted = container.querySelector<HTMLElement>('.activity-lane .activity-lane-presence.is-ticket')!
  expect(tinted.style.background).toBe('var(--viz-1)')
  expect(tinted.title).toContain('TECH-1, présence')
  expect(container.querySelector('.activity-lane .activity-lane-presence:not(.is-ticket)')?.getAttribute('title')).toContain('Présence de')
  expect(container.querySelectorAll('.activity-timeline-ticket')).toHaveLength(1)
  expect([...ticketColors(projects).entries()]).toEqual([['TECH-1', 'var(--viz-1)']])
  expect([...container.querySelectorAll('.activity-timeline-hour')].map((hour) => hour.textContent).filter(Boolean)).toEqual(['8 h', '9 h', '10 h', '11 h', '12 h', '13 h', '14 h', '15 h', '16 h', '17 h', '18 h', '19 h', '20 h'])
})
