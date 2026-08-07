import { useState } from 'react'
import Markdown from './Markdown'
import { runTestScope } from './api'
import type { TestInventoryBlock } from './groupEvents'
import type { TestScope } from './types'
import { ImageGallery } from './EventView'

interface TestInventoryCardProps {
  block: TestInventoryBlock
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
}

const METHOD_LABEL = {
  unit: 'Unitaire',
  browser: 'Navigateur',
  manual: 'Guidé',
} as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de lancer ce scope.'
}

export function TestInventoryCard({ block, onImageOpen, onImageLoad }: TestInventoryCardProps) {
  const [startingId, setStartingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function start(scope: TestScope) {
    setStartingId(scope.id)
    setError(null)
    try {
      await runTestScope(scope.id)
    } catch (startError: unknown) {
      setError(errorMessage(startError))
    } finally {
      setStartingId(null)
    }
  }

  return (
    <section className="test-inventory-card" aria-label="Inventaire de test">
      <header>
        <div>
          <span className="test-kicker">Contrôle vérifiable</span>
          <h2>Que voulez-vous tester ?</h2>
        </div>
        <span>{block.scopes.length} scope{block.scopes.length === 1 ? '' : 's'}</span>
      </header>
      <p className="test-inventory-intro">
        Choisissez un périmètre : l’agent exécutera les vérifications et conservera
        sorties, captures et verdict dans ce fil.
      </p>
      {error ? <p className="test-card-error" role="alert">{error}</p> : null}
      {block.scopes.length === 0 ? (
        <p className="test-inventory-empty">
          Aucun élément testable n’a été identifié dans cette conversation.
        </p>
      ) : null}
      <div className="test-scope-list">
        {block.scopes.map((scope, index) => {
          const status = scope.status
          const evidence = scope.evidenceMd ?? scope.evidence_md ?? null
          const flagIds = scope.guardianFlagIds ?? scope.guardian_flag_ids ?? []
          const ackedFlagIds = scope.guardianFlagIdsAcked ?? []
          return (
            <article className={`test-scope is-${status}`} key={scope.id}>
              <div className="test-scope-number">{String(index + 1).padStart(2, '0')}</div>
              <div className="test-scope-main">
                <div className="test-scope-heading">
                  <div>
                    <h3>{scope.title}</h3>
                    <p>{scope.description}</p>
                  </div>
                  <span className={`test-status is-${status}`}>
                    {status === 'pending' ? 'à choisir'
                      : status === 'running' ? 'en cours'
                        : status === 'passed' ? 'réussi' : 'échec'}
                  </span>
                </div>
                <div className="test-methods">
                  {scope.methods.map((method, methodIndex) => (
                    <details key={`${method.kind}-${methodIndex}`}>
                      <summary>
                        <span>{METHOD_LABEL[method.kind]}</span>
                        {method.label}
                      </summary>
                      <p>{method.instructions}</p>
                    </details>
                  ))}
                </div>
                <div className="test-scope-actions">
                  {flagIds.length > 0 ? (
                    <span title="Ces alertes Gardien seront acquittées seulement si le scope réussit">
                      Gardien · {flagIds.length} point{flagIds.length === 1 ? '' : 's'} lié{flagIds.length === 1 ? '' : 's'}
                    </span>
                  ) : <span />}
                  <button
                    type="button"
                    onClick={() => void start(scope)}
                    disabled={status === 'running' || startingId === scope.id}
                    title="Exécuter ce périmètre et conserver les preuves dans le fil"
                  >
                    {startingId === scope.id ? 'Lancement…'
                      : status === 'passed' || status === 'failed' ? 'Retester ce scope'
                        : 'Tester ce scope'}
                  </button>
                </div>
                {evidence ? (
                  <details className="test-evidence" open={status === 'failed'}>
                    <summary>Preuves et verdict</summary>
                    <Markdown>{evidence}</Markdown>
                  </details>
                ) : null}
                <ImageGallery
                  images={scope.images ?? []}
                  label={`Capture du test ${scope.title}`}
                  onImageOpen={onImageOpen}
                  onImageLoad={onImageLoad}
                />
                {ackedFlagIds.length > 0 ? (
                  <p className="test-guardian-acked">
                    Gardien · {ackedFlagIds.length} point{ackedFlagIds.length === 1 ? '' : 's'} acquitté{ackedFlagIds.length === 1 ? '' : 's'}
                  </p>
                ) : null}
                {scope.error ? <p className="test-card-error">{scope.error}</p> : null}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
