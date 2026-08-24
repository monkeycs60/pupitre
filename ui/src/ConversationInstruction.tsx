import { useState } from 'react'

export function ConversationInstruction({ instruction }: { instruction: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className="conversation-instruction-badge"
        onClick={() => setOpen(true)}
        title="Consulter l’instruction injectée au démarrage"
      >
        Instruction injectée
      </button>
      {open ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
          <section className="modal review-dialog conversation-instruction-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-instruction-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div>
                <h2 id="conversation-instruction-title">Instruction injectée</h2>
                <p>Snapshot reçu par cette conversation lors de sa création.</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setOpen(false)} aria-label="Fermer">×</button>
            </header>
            <div className="conversation-instruction-content">{instruction}</div>
            <footer className="modal-actions">
              <button type="button" className="primary-button" onClick={() => setOpen(false)}>Fermer</button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  )
}
