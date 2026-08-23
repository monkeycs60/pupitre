import { useEffect, useState } from 'react'
import {
  createProjectDomain,
  deleteProjectDomain,
  listProjectDomains,
  mergeProjectDomain,
  renameProjectDomain,
  validateProjectDomain,
} from './api'
import type { DomainKind, ProjectDomain } from './types'

interface DomainSettingsProps {
  projectId: string
  disabled?: boolean
  onChanged?: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de mettre à jour les domaines.'
}

export function DomainSettings({ projectId, disabled = false, onChanged }: DomainSettingsProps) {
  const [domains, setDomains] = useState<ProjectDomain[]>([])
  const [name, setName] = useState('')
  const [kind, setKind] = useState<DomainKind>('technique')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [mergingId, setMergingId] = useState<string | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void listProjectDomains(projectId, controller.signal)
      .then(setDomains)
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(loadError))
      })
    return () => controller.abort()
  }, [projectId])

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      const next = await listProjectDomains(projectId)
      setDomains(next)
      setRenamingId(null)
      setMergingId(null)
      setMergeTargetId('')
      onChanged?.()
    } catch (mutateError: unknown) {
      setError(errorMessage(mutateError))
    } finally {
      setBusy(false)
    }
  }

  const proposed = domains.filter((domain) => domain.status === 'proposé')
  const active = domains.filter((domain) => domain.status === 'actif')
  const locked = disabled || busy

  return (
    <section className="project-domains" aria-labelledby="project-domains-title">
      <div className="project-settings-section-heading">
        <strong id="project-domains-title">Domaines</strong>
        <span>Les propositions du digest restent invisibles tant qu’elles ne sont pas validées.</span>
      </div>
      {error ? <p className="project-domains-error" role="alert">{error}</p> : null}
      {proposed.length > 0 ? (
        <div className="project-domain-group">
          <h3>Proposés</h3>
          {proposed.map((domain) => (
            <DomainRow
              key={domain.id}
              domain={domain}
              others={domains.filter((item) => item.id !== domain.id)}
              locked={locked}
              renamingId={renamingId}
              renameValue={renameValue}
              mergingId={mergingId}
              mergeTargetId={mergeTargetId}
              onRenameStart={() => { setRenamingId(domain.id); setRenameValue(domain.name) }}
              onRenameValue={setRenameValue}
              onMergeStart={() => {
                setMergingId(domain.id)
                setMergeTargetId(domains.find((item) => item.id !== domain.id)?.id ?? '')
              }}
              onMergeTarget={setMergeTargetId}
              onValidate={() => void mutate(() => validateProjectDomain(projectId, domain.id))}
              onRename={() => void mutate(() => renameProjectDomain(projectId, domain.id, { name: renameValue }))}
              onMerge={() => void mutate(() => mergeProjectDomain(projectId, domain.id, mergeTargetId))}
              onDelete={() => void mutate(() => deleteProjectDomain(projectId, domain.id))}
              onCancel={() => { setRenamingId(null); setMergingId(null) }}
            />
          ))}
        </div>
      ) : null}
      {active.length > 0 ? (
        <div className="project-domain-group">
          <h3>Actifs</h3>
          {active.map((domain) => (
            <DomainRow
              key={domain.id}
              domain={domain}
              others={domains.filter((item) => item.id !== domain.id)}
              locked={locked}
              renamingId={renamingId}
              renameValue={renameValue}
              mergingId={mergingId}
              mergeTargetId={mergeTargetId}
              onRenameStart={() => { setRenamingId(domain.id); setRenameValue(domain.name) }}
              onRenameValue={setRenameValue}
              onMergeStart={() => {
                setMergingId(domain.id)
                setMergeTargetId(domains.find((item) => item.id !== domain.id)?.id ?? '')
              }}
              onMergeTarget={setMergeTargetId}
              onRename={() => void mutate(() => renameProjectDomain(projectId, domain.id, { name: renameValue }))}
              onMerge={() => void mutate(() => mergeProjectDomain(projectId, domain.id, mergeTargetId))}
              onDelete={() => void mutate(() => deleteProjectDomain(projectId, domain.id))}
              onCancel={() => { setRenamingId(null); setMergingId(null) }}
            />
          ))}
        </div>
      ) : null}
      {domains.length === 0 ? <p>Aucun domaine pour l’instant.</p> : null}
      <form
        className="project-domain-create"
        onSubmit={(event) => {
          event.preventDefault()
          void mutate(async () => {
            await createProjectDomain(projectId, { name, kind })
            setName('')
          })
        }}
      >
        <label htmlFor="project-domain-name">
          <strong>Nouveau domaine</strong>
          <input
            id="project-domain-name"
            value={name}
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label htmlFor="project-domain-kind">
          <strong>Kind</strong>
          <select
            id="project-domain-kind"
            value={kind}
            disabled={locked}
            onChange={(event) => setKind(event.target.value as DomainKind)}
          >
            <option value="technique">technique</option>
            <option value="métier">métier</option>
          </select>
        </label>
        <button type="submit" disabled={locked || name.trim() === ''}>Créer</button>
      </form>
    </section>
  )
}

function DomainRow({
  domain,
  others,
  locked,
  renamingId,
  renameValue,
  mergingId,
  mergeTargetId,
  onRenameStart,
  onRenameValue,
  onMergeStart,
  onMergeTarget,
  onValidate,
  onRename,
  onMerge,
  onDelete,
  onCancel,
}: {
  domain: ProjectDomain
  others: ProjectDomain[]
  locked: boolean
  renamingId: string | null
  renameValue: string
  mergingId: string | null
  mergeTargetId: string
  onRenameStart: () => void
  onRenameValue: (value: string) => void
  onMergeStart: () => void
  onMergeTarget: (value: string) => void
  onValidate?: () => void
  onRename: () => void
  onMerge: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  const kindClass = domain.kind === 'métier' ? 'metier' : 'technique'
  return (
    <article className="project-domain-row" data-status={domain.status}>
      <span className={`project-domain-chip project-domain-chip-${kindClass}`}>{domain.name}</span>
      <span className="project-domain-meta">{domain.kind} · {domain.status}</span>
      <span className="project-domain-actions">
        {onValidate ? (
          <button type="button" className="text-button" disabled={locked} onClick={onValidate}>
            Valider
          </button>
        ) : null}
        {renamingId === domain.id ? (
          <>
            <input
              value={renameValue}
              aria-label={`Nouveau nom pour ${domain.name}`}
              disabled={locked}
              onChange={(event) => onRenameValue(event.target.value)}
            />
            <button type="button" className="text-button" disabled={locked || renameValue.trim() === ''} onClick={onRename}>
              Enregistrer
            </button>
            <button type="button" className="text-button" disabled={locked} onClick={onCancel}>Annuler</button>
          </>
        ) : mergingId === domain.id ? (
          <>
            <select
              aria-label={`Fusionner ${domain.name} vers`}
              value={mergeTargetId}
              disabled={locked || others.length === 0}
              onChange={(event) => onMergeTarget(event.target.value)}
            >
              {others.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button type="button" className="text-button" disabled={locked || !mergeTargetId} onClick={onMerge}>
              Fusionner
            </button>
            <button type="button" className="text-button" disabled={locked} onClick={onCancel}>Annuler</button>
          </>
        ) : (
          <>
            <button type="button" className="text-button" disabled={locked} onClick={onRenameStart}>Renommer</button>
            <button type="button" className="text-button" disabled={locked || others.length === 0} onClick={onMergeStart}>
              Fusionner
            </button>
            <button type="button" className="text-button" disabled={locked} onClick={onDelete}>Supprimer</button>
          </>
        )}
      </span>
    </article>
  )
}
