import { useEffect, useState } from 'react'
import { getUsageReport, type UsageReport } from './api'
import { absoluteCodeDate, relativeCodeDate } from './codeFormat'
import { USAGE_AREAS } from './usageCatalog'

const USAGE_PERIODS = [7, 30, 90] as const
type UsagePeriod = (typeof USAGE_PERIODS)[number]
type UsageFeatureCount = UsageReport['catalog'][number]

const JARVIS_PATHS: Record<UsageReport['jarvis']['questions'][number]['path'], string> = {
  haiku: 'Haiku 5.5 seul',
  router: 'Jev, puis Opus 5.5',
  handoff: 'Haiku 5.5, puis Opus 5.5',
  fast: 'Mode Rapide',
  orchestrate: 'Mode Orchestrer',
}

const JARVIS_ACTIONS: Record<string, string> = {
  open: 'Ouvrir et surligner',
  'send-message': 'Répondre à un agent',
  'new-conversation': 'Démarrer une conversation',
  archive: 'Archiver',
  pin: 'Épingler',
  stop: 'Interrompre un tour',
  'open-url': 'Ouvrir un serveur',
}

const formatCount = (value: number) => value.toLocaleString('fr-FR')
const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${formatCount(count)} ${count > 1 ? pluralForm : singular}`
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })

function splitUsage(catalog: UsageFeatureCount[]): { used: UsageFeatureCount[]; unused: Array<[string, UsageFeatureCount[]]> } {
  const used = catalog.filter((feature) => feature.count > 0)
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'fr'))
  const areas = new Map<string, UsageFeatureCount[]>(USAGE_AREAS.map((area) => [area, []]))
  for (const feature of catalog) if (feature.count === 0) areas.set(feature.area, [...(areas.get(feature.area) ?? []), feature])
  return { used, unused: [...areas.entries()].filter(([, features]) => features.length > 0) }
}

function UsageSummary({ daily }: { daily: UsageReport['daily'] }) {
  const total = daily.reduce((sum, day) => sum + day.count, 0)
  const active = daily.filter((day) => day.count > 0)
  const first = active[0]?.day
  return (
    <p className="usage-meta">
      {[
        plural(total, 'interaction'),
        `${plural(active.length, 'jour actif', 'jours actifs')} sur ${daily.length}`,
        first && first !== daily[0]?.day ? `première le ${shortDay(first)}` : null,
      ].filter(Boolean).join(' · ')}
    </p>
  )
}

function UsageFeatures({ catalog }: { catalog: UsageFeatureCount[] }) {
  const { used, unused } = splitUsage(catalog)
  const unusedCount = unused.reduce((sum, [, features]) => sum + features.length, 0)
  return <>
    <div className="usage-unused">
      <h2>Jamais utilisées sur la période <small>{unusedCount}</small></h2>
      {unusedCount > 0 ? <>
        <p>Aucune interaction enregistrée : les candidates au retrait.</p>
        <div className="usage-areas">
          {unused.map(([area, features]) => (
            <div key={area}>
              <h3>{area}</h3>
              <ul>{features.map((feature) => <li key={feature.feature}>{feature.label}</li>)}</ul>
            </div>
          ))}
        </div>
      </> : <p>Toutes les fonctions suivies ont servi sur la période.</p>}
    </div>
    <h2 className="usage-section">Utilisées <small>{used.length}</small></h2>
    <table className="usage-table">
      <thead>
        <tr><th>Fonction</th><th>Zone</th><th className="is-number">Utilisations</th><th>Dernière utilisation</th></tr>
      </thead>
      <tbody>
        {used.map((feature) => (
          <tr key={feature.feature}>
            <td>{feature.label}</td>
            <td className="is-muted">{feature.area}</td>
            <td className="is-number">{formatCount(feature.count)}</td>
            <td className="is-muted" title={absoluteCodeDate(feature.lastAt)}>{relativeCodeDate(feature.lastAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </>
}

function UsageJarvis({ jarvis }: { jarvis: UsageReport['jarvis'] }) {
  const total = jarvis.questions.reduce((sum, row) => sum + row.count, 0)
  const seconds = (value: number | null) => value === null ? '—' : `${value.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`
  return <>
    <h2 className="usage-section">Jarvis <small>{plural(total, 'question')}</small></h2>
    <table className="usage-table">
      <thead>
        <tr><th>Qui a choisi le modèle</th><th className="is-number">Questions</th><th className="is-number">Durée médiane</th><th className="is-number">Échecs</th></tr>
      </thead>
      <tbody>
        {jarvis.questions.map((row) => (
          <tr key={row.path}>
            <td>{JARVIS_PATHS[row.path]}</td>
            <td className="is-number">{formatCount(row.count)}</td>
            <td className="is-number">{seconds(row.medianSeconds)}</td>
            <td className="is-number">{formatCount(row.failed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {jarvis.actions.length > 0 ? (
      <table className="usage-table">
        <thead>
          <tr><th>Action proposée</th><th className="is-number">Proposée</th><th className="is-number">Exécutée</th><th className="is-number">Ignorée</th><th className="is-number">Échec</th></tr>
        </thead>
        <tbody>
          {jarvis.actions.map((row) => (
            <tr key={row.kind}>
              <td>{JARVIS_ACTIONS[row.kind] ?? row.kind}</td>
              <td className="is-number">{formatCount(row.proposed)}</td>
              <td className="is-number">{formatCount(row.done)}</td>
              <td className="is-number">{formatCount(row.ignored)}</td>
              <td className="is-number">{formatCount(row.failed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : <p className="usage-note">Aucune action proposée sur la période.</p>}
  </>
}

export function ActivityUsage() {
  const [days, setDays] = useState<UsagePeriod>(30)
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getUsageReport(days, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setReport(next) })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Chargement impossible') })
    return () => controller.abort()
  }, [days])

  function choose(period: UsagePeriod) {
    setError(null)
    setDays(period)
  }

  const interactions = report?.daily.some((day) => day.count > 0) ?? false
  return (
    <section className="usage">
      <div className="agenda-toolbar">
        <div className="agenda-segmented" role="group" aria-label="Période">
          {USAGE_PERIODS.map((period) => (
            <button type="button" key={period} aria-pressed={days === period} className={days === period ? 'is-active' : ''} onClick={() => choose(period)}>
              {period} jours
            </button>
          ))}
        </div>
        {report ? <UsageSummary daily={report.daily} /> : null}
      </div>
      {error ? <p className="modal-error" role="alert">{error}</p> : null}
      {!report ? (error ? null : <div className="empty-state"><p>Chargement de l’usage…</p></div>) : <>
        {interactions
          ? <UsageFeatures catalog={report.catalog} />
          : <p className="usage-note">Aucune interaction mesurée sur la période : rien à conclure sur les fonctions suivies.</p>}
        {report.jarvis.questions.length > 0 ? <UsageJarvis jarvis={report.jarvis} /> : null}
        <h2 className="usage-section">Travail de fond</h2>
        {report.background.length > 0 ? (
          <table className="usage-table">
            <thead>
              <tr><th>Appel automatique</th><th className="is-number">Appels</th></tr>
            </thead>
            <tbody>
              {report.background.map((item) => (
                <tr key={item.kind}>
                  <td>{capitalize(item.kind)}</td>
                  <td className="is-number">{formatCount(item.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="usage-note">Aucun appel automatique sur la période.</p>}
      </>}
    </section>
  )
}
