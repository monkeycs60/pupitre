import { useState, type ReactElement } from 'react'
import type { GamificationPeriod, GamificationSnapshot } from './types'

interface ProgressViewProps {
  snapshot: GamificationSnapshot | null
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes} min`
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
}

function maxComplexity(period: GamificationPeriod): number {
  return Math.max(1, ...Object.values(period.complexity))
}

/** Objectifs indicatifs (pas de cible fournie par le snapshot) : bornes rondes
 *  calibrées sur un rythme d'usage courant, affichées comme repère, pas comme
 *  promesse. */
const GOAL_XP = 500
const GOAL_CONVERSATIONS = 15
const GOAL_ACTIVE_MS = 8 * 60 * 60_000

interface Badge {
  name: string
  meta: string
  unlocked: boolean
  icon: 'level' | 'projects' | 'pace' | 'commits' | 'time' | 'focus'
}

const BADGE_ICONS: Record<Badge['icon'], ReactElement> = {
  level: (
    <path d="M8 1.5 9.9 5.4 14.2 6l-3.1 3 .7 4.3L8 11.3 4.2 13.3l.7-4.3-3.1-3 4.3-.6z" fill="currentColor" />
  ),
  projects: (
    <path d="M2 3.5h4.5L8 5.5h6v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" fill="currentColor" />
  ),
  pace: (
    <path d="M2 13 5.5 6l2.5 4 2-6 3 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  ),
  commits: (
    <>
      <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M1.5 8h4M10.5 8h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  time: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 4.5V8l2.6 1.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  focus: (
    <path d="M8.5 1.5 3 9h4l-.5 5.5L13 7H9z" fill="currentColor" />
  ),
}

function BadgeIcon({ icon }: { icon: Badge['icon'] }) {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
      {BADGE_ICONS[icon]}
    </svg>
  )
}

export function ProgressView({ snapshot }: ProgressViewProps) {
  const [copied, setCopied] = useState(false)
  if (!snapshot) {
    return <div className="progress-view progress-view-empty">Chargement de la progression…</div>
  }

  const report = [
    `Pupitre · niveau ${snapshot.level}`,
    `Cette semaine : +${snapshot.week.xp} XP · ${snapshot.week.projects} projets · ${snapshot.week.conversations} conversations`,
    `${snapshot.week.commits} commits · ${snapshot.week.pushes} pushes · ${formatDuration(snapshot.week.activeMs)} actives`,
    `Tokens : ${snapshot.week.inputTokens} input · ${snapshot.week.outputTokens} output`,
  ].join('\n')

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  const ringLen = 283
  const progress = Math.max(0, Math.min(1, snapshot.progress))
  const ringOffset = ringLen * (1 - progress)
  const xpToNext = Math.max(0, snapshot.nextLevelXp - snapshot.xp)
  const max = maxComplexity(snapshot.week)
  const complexityEntries = Object.entries(snapshot.week.complexity)
  const totalComplexityCount = complexityEntries.reduce((sum, [, count]) => sum + count, 0)

  const stats: Array<{ label: string; value: string; trend: string }> = [
    { label: 'XP · semaine', value: `+${snapshot.week.xp.toLocaleString('fr-FR')}`, trend: `auj. +${snapshot.today.xp.toLocaleString('fr-FR')}` },
    { label: 'Projets', value: String(snapshot.week.projects), trend: `auj. ${snapshot.today.projects}` },
    { label: 'Conversations', value: String(snapshot.week.conversations), trend: `auj. ${snapshot.today.conversations}` },
    { label: 'Commits / push', value: `${snapshot.week.commits} / ${snapshot.week.pushes}`, trend: `auj. ${snapshot.today.commits} / ${snapshot.today.pushes}` },
    { label: 'Temps actif', value: formatDuration(snapshot.week.activeMs), trend: `auj. ${formatDuration(snapshot.today.activeMs)}` },
  ]

  const goals = [
    {
      label: 'XP cette semaine',
      value: `${Math.min(snapshot.week.xp, GOAL_XP).toLocaleString('fr-FR')} / ${GOAL_XP.toLocaleString('fr-FR')}`,
      pct: Math.min(100, (snapshot.week.xp / GOAL_XP) * 100),
      hint: snapshot.week.xp >= GOAL_XP ? 'Objectif atteint' : `Encore ${(GOAL_XP - snapshot.week.xp).toLocaleString('fr-FR')} XP`,
    },
    {
      label: 'Conversations',
      value: `${Math.min(snapshot.week.conversations, GOAL_CONVERSATIONS)} / ${GOAL_CONVERSATIONS}`,
      pct: Math.min(100, (snapshot.week.conversations / GOAL_CONVERSATIONS) * 100),
      hint: snapshot.week.conversations >= GOAL_CONVERSATIONS ? 'Objectif atteint' : `Encore ${GOAL_CONVERSATIONS - snapshot.week.conversations}`,
    },
    {
      label: 'Temps actif',
      value: `${formatDuration(Math.min(snapshot.week.activeMs, GOAL_ACTIVE_MS))} / ${formatDuration(GOAL_ACTIVE_MS)}`,
      pct: Math.min(100, (snapshot.week.activeMs / GOAL_ACTIVE_MS) * 100),
      hint: snapshot.week.activeMs >= GOAL_ACTIVE_MS ? 'Objectif atteint' : `Encore ${formatDuration(GOAL_ACTIVE_MS - snapshot.week.activeMs)}`,
    },
  ]

  const badges: Badge[] = [
    { name: `Niveau ${snapshot.level}`, meta: `${snapshot.xp.toLocaleString('fr-FR')} XP`, unlocked: true, icon: 'level' },
    { name: 'Multi-projets', meta: `${snapshot.week.projects} projets`, unlocked: snapshot.week.projects >= 2, icon: 'projects' },
    { name: 'Rythme soutenu', meta: `${snapshot.week.conversations} conv.`, unlocked: snapshot.week.conversations >= 10, icon: 'pace' },
    { name: 'Builder', meta: `${snapshot.week.commits} commits`, unlocked: snapshot.week.commits >= 5, icon: 'commits' },
    { name: 'Sessions longues', meta: formatDuration(snapshot.week.activeMs), unlocked: snapshot.week.activeMs >= 4 * 60 * 60_000, icon: 'time' },
    { name: 'Focus', meta: `×${snapshot.focusMultiplier.toLocaleString('fr-FR')}`, unlocked: snapshot.focusMultiplier > 1, icon: 'focus' },
  ]
  const unlockedCount = badges.filter((b) => b.unlocked).length

  return (
    <div className="progress-view">
      <div className="progress-container">
        <div className="progress-toolbar">
          <button type="button" className="secondary-button" onClick={() => void copyReport()}>
            {copied ? 'Copié' : 'Copier le rapport'}
          </button>
        </div>

        <div className="progress-hero">
          <div className="progress-ring" aria-hidden="true">
            <svg width="104" height="104" viewBox="0 0 104 104">
              <circle cx="52" cy="52" r="45" fill="none" stroke="var(--border-subtle)" strokeWidth="7" />
              <circle
                cx="52"
                cy="52"
                r="45"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={ringLen}
                strokeDashoffset={ringOffset}
                transform="rotate(-90 52 52)"
                className="progress-ring-fill"
                style={{ '--ring-len': ringLen } as React.CSSProperties}
              />
            </svg>
            <div className="progress-ring-label">
              <span>Niveau</span>
              <strong>{snapshot.level}</strong>
            </div>
          </div>

          <div className="progress-hero-main">
            <h1>Bien joué, il te reste {xpToNext.toLocaleString('fr-FR')} XP</h1>
            <p>{snapshot.xp.toLocaleString('fr-FR')} XP au total · niveau {snapshot.level + 1} au prochain palier</p>
            <div className="progress-xp-track" aria-label={`${Math.round(progress * 100)} % du niveau suivant`}>
              <span className="progress-xp-fill" style={{ width: `${progress * 100}%` }} />
              <span className="progress-xp-sheen" />
            </div>
          </div>

          <div className="progress-focus-card">
            <div className="progress-focus-card-row">
              <span className="progress-focus-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16">{BADGE_ICONS.focus}</svg>
              </span>
              <div>
                <div className="progress-focus-value">×{snapshot.focusMultiplier.toLocaleString('fr-FR')}</div>
                <div className="progress-focus-caption">multiplicateur focus</div>
              </div>
            </div>
            <div className="progress-focus-sub">{formatDuration(snapshot.activeMsToday)} actives aujourd’hui</div>
          </div>
        </div>

        <div className="progress-stat-grid">
          {stats.map((s) => (
            <div className="progress-stat-tile" key={s.label}>
              <div className="progress-stat-label">{s.label}</div>
              <div className="progress-stat-value">{s.value}</div>
              <div className="progress-stat-trend">{s.trend}</div>
            </div>
          ))}
        </div>

        <div className="progress-two-col">
          <div>
            <div className="progress-col-heading">
              <h2>Objectifs de la semaine</h2>
              <span>repères indicatifs</span>
            </div>
            <div className="progress-goals">
              {goals.map((g) => (
                <div className="progress-goal-card" key={g.label} data-complete={g.pct >= 100}>
                  <div className="progress-goal-top">
                    <span>{g.label}</span>
                    <span className="progress-goal-value">{g.value}</span>
                  </div>
                  <div className="progress-goal-track">
                    <span style={{ width: `${g.pct}%` }} />
                  </div>
                  <div className="progress-goal-hint">{g.hint}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="progress-col-heading">
              <h2>Répartition des conversations</h2>
              <span>par complexité · {totalComplexityCount} au total</span>
            </div>
            <div className="progress-complexity-rows">
              {complexityEntries.map(([label, count]) => (
                <div className="progress-complexity-row" key={label}>
                  <span className="progress-complexity-chip">{label.slice(0, 2).toUpperCase()}</span>
                  <div className="progress-complexity-mid">
                    <div className="progress-complexity-mid-top">
                      <span>{label}</span>
                      <span>{count}</span>
                    </div>
                    <div className="progress-complexity-track">
                      <span style={{ width: `${(count / max) * 100}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="progress-badges-section">
          <div className="progress-col-heading">
            <h2>Hauts faits</h2>
            <span>{unlockedCount} / {badges.length} débloqués</span>
          </div>
          <div className="progress-badges-grid">
            {badges.map((b) => (
              <div className="progress-badge" key={b.name} data-unlocked={b.unlocked} title={b.meta}>
                <span className="progress-badge-icon"><BadgeIcon icon={b.icon} /></span>
                <span className="progress-badge-name">{b.name}</span>
                <span className="progress-badge-meta">{b.meta}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
