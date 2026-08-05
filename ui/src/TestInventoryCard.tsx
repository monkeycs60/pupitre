import type { TestInventoryBlock } from './groupEvents'

interface TestInventoryCardProps {
  block: TestInventoryBlock
}

const METHOD_LABEL = {
  unit: 'Unitaire',
  browser: 'Navigateur',
  manual: 'Guidé',
} as const

export function TestInventoryCard({ block }: TestInventoryCardProps) {
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
        Chaque périmètre décrit les vérifications disponibles et les points du Gardien
        auxquels elles répondent.
      </p>
      {block.scopes.length === 0 ? (
        <p className="test-inventory-empty">
          Aucun élément testable n’a été identifié dans cette conversation.
        </p>
      ) : null}
      <div className="test-scope-list">
        {block.scopes.map((scope, index) => {
          const status = scope.status
          const flagIds = scope.guardianFlagIds ?? scope.guardian_flag_ids ?? []
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
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
