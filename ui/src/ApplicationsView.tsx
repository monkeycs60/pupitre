import { ExternalLink } from './externalLink'
import { refreshRunningApplications, useRunningApplications } from './runningApplicationsStore'

function OpenIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3h7v7M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />
    </svg>
  )
}

export function ApplicationsView() {
  const { items, loading, error, updatedAt } = useRunningApplications()

  return (
    <div className="applications-view">
      <header className="applications-header">
        <div>
          <h1>Applications</h1>
          <p>Ports en écoute dans les projets et worktrees connus de Pupitre.</p>
        </div>
        <div className="applications-header-actions">
          {updatedAt !== null ? <span>Actualisé à {new Date(updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> : null}
          <button type="button" className="secondary-button" onClick={() => void refreshRunningApplications()}>
            Actualiser
          </button>
        </div>
      </header>

      {error ? <div className="applications-error" role="alert">{error}</div> : null}
      {loading && items.length === 0 ? <div className="empty-state"><p>Détection des applications…</p></div>
      : items.length === 0 ? <div className="empty-state"><p>Aucune application détectée dans les projets connus.</p></div>
      : (
        <div className="applications-table" role="table" aria-label="Applications en cours d’exécution">
          <div className="applications-row applications-table-head" role="row">
            <span role="columnheader">Application</span>
            <span role="columnheader">Projet / worktree</span>
            <span role="columnheader">Port</span>
            <span role="columnheader">Processus</span>
            <span role="columnheader" aria-label="Ouvrir" />
          </div>
          {items.map((application) => (
            <div className="applications-row" role="row" key={application.id}>
              <div className="applications-name" role="cell">
                <strong>{application.name}</strong>
                <span>{application.cwd}</span>
              </div>
              <div className="applications-context" role="cell">
                <strong>{application.projectName}</strong>
                <span>{application.branch ?? application.workspace}</span>
              </div>
              <code role="cell">{application.port}</code>
              <div className="applications-process" role="cell">
                <span>{application.process}</span>
                <code>PID {application.pid}</code>
              </div>
              <ExternalLink
                className="applications-open"
                href={application.url}
                title={`Ouvrir ${application.url}`}
                ariaLabel={`Ouvrir ${application.name} sur le port ${application.port}`}
              >
                <span>localhost:{application.port}</span>
                <OpenIcon />
              </ExternalLink>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
