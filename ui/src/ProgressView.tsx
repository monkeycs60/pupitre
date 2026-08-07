import { useState } from 'react'
import type { GamificationPeriod, GamificationSnapshot } from './types'

interface ProgressViewProps {
  snapshot: GamificationSnapshot | null
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`
  if (value >= 1_000) return `${(value / 1_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k`
  return value.toLocaleString('fr-FR')
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

function PeriodRows({ period }: { period: GamificationPeriod }) {
  return (
    <div className="progress-metrics" aria-label="Statistiques de période">
      <div><span>Projets impactés</span><strong>{period.projects}</strong></div>
      <div><span>Conversations</span><strong>{period.conversations}</strong></div>
      <div><span>Commits / pushes</span><strong>{period.commits} / {period.pushes}</strong></div>
      <div><span>Lignes + / −</span><strong>{period.additions.toLocaleString('fr-FR')} / {period.deletions.toLocaleString('fr-FR')}</strong></div>
      <div><span>Tokens input</span><strong>{formatTokens(period.inputTokens)}</strong></div>
      <div><span>Tokens output</span><strong>{formatTokens(period.outputTokens)}</strong></div>
      <div><span>Temps actif</span><strong>{formatDuration(period.activeMs)}</strong></div>
      <div><span>XP gagnée</span><strong className="progress-accent">+{period.xp.toLocaleString('fr-FR')}</strong></div>
    </div>
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
  const max = maxComplexity(snapshot.week)

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="progress-view">
      <header className="progress-header">
        <div>
          <h1>Progression · niveau {snapshot.level}</h1>
          <p>{snapshot.xp.toLocaleString('fr-FR')} XP · encore {(snapshot.nextLevelXp - snapshot.xp).toLocaleString('fr-FR')} XP avant le prochain niveau</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void copyReport()}>
          {copied ? 'Copié' : 'Copier le rapport'}
        </button>
      </header>

      <div className="progress-level-track" aria-label={`${Math.round(snapshot.progress * 100)} % du niveau suivant`}>
        <span style={{ width: `${snapshot.progress * 100}%` }} />
      </div>

      <section className="progress-section progress-week-section" aria-labelledby="progress-week-title">
        <div className="progress-section-heading">
          <div>
            <h2 id="progress-week-title">Cette semaine</h2>
            <p>Du lundi à aujourd’hui · activité locale de Pupitre</p>
          </div>
          <strong className="progress-week-xp">+{snapshot.week.xp.toLocaleString('fr-FR')} XP</strong>
        </div>
        <PeriodRows period={snapshot.week} />
      </section>

      <section className="progress-section" aria-labelledby="progress-complexity-title">
        <div className="progress-section-heading">
          <div>
            <h2 id="progress-complexity-title">Répartition des conversations</h2>
            <p>La complexité multiplie l’XP ; elle ne juge pas le résultat.</p>
          </div>
          <span className="progress-focus">Focus aujourd’hui ×{snapshot.focusMultiplier.toLocaleString('fr-FR')}</span>
        </div>
        <div className="complexity-list">
          {Object.entries(snapshot.week.complexity).map(([label, count]) => (
            <div className="complexity-row" key={label}>
              <span>{label}</span>
              <span className="complexity-track" aria-hidden="true">
                <span style={{ width: `${(count / max) * 100}%` }} />
              </span>
              <strong>{count}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="progress-section progress-today" aria-labelledby="progress-today-title">
        <div className="progress-section-heading">
          <div>
            <h2 id="progress-today-title">Aujourd’hui</h2>
            <p>Le bonus augmente par tranche de 10 minutes actives.</p>
          </div>
          <strong className="progress-focus">×{snapshot.focusMultiplier.toLocaleString('fr-FR')}</strong>
        </div>
        <PeriodRows period={snapshot.today} />
      </section>
    </div>
  )
}
