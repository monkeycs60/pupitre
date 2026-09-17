import { ExternalLink } from './externalLink'
import { groupRunningApplications } from './applicationGroups'
import { BranchIcon } from './BranchIcon'
import { ProjectGlyph } from './ProjectGlyph'
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
  const projects = groupRunningApplications(items)

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
            <span role="columnheader">Worktree</span>
            <span role="columnheader">Port</span>
            <span role="columnheader">Processus</span>
            <span role="columnheader" aria-label="Ouvrir" />
          </div>
          {projects.map((project) => (
            <section className="applications-project" role="region" aria-label={project.name} key={project.id}>
              <div className="applications-project-header">
                <span className="applications-project-glyph"><ProjectGlyph projectId={project.id} /></span>
                <div>
                  <h2>{project.name}</h2>
                  <span>{project.branches.length} branche{project.branches.length > 1 ? 's' : ''}</span>
                </div>
                <strong>{project.applicationCount} application{project.applicationCount > 1 ? 's' : ''}</strong>
              </div>
              {project.branches.map((branch) => (
                <div className="applications-group" role="rowgroup" aria-label={`${project.name} — ${branch.label}`} key={branch.id}>
                  <div className="applications-group-header">
                    <span className="applications-branch-title"><BranchIcon /><strong>{branch.label}</strong></span>
                    <span>{branch.applications.length} application{branch.applications.length > 1 ? 's' : ''}</span>
                  </div>
                  {branch.applications.map((application) => (
                    <div className="applications-row" role="row" key={application.id}>
                      <div className="applications-name" role="cell">
                        <strong>{application.name}</strong>
                        <span>{application.cwd}</span>
                      </div>
                      <code className="applications-worktree" role="cell">{application.workspace}</code>
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
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
