import { useEffect, useRef, useState } from 'react'
import {
  createHandoffDocument,
  getDiscussionDocument,
  type DiscussionDocument,
  type HandoffDocument,
} from './api'
import Markdown from './Markdown'
import { copyText } from './clipboard'
import type { Conversation } from './types'

interface HandoffModalProps {
  conversation: Conversation
  /** `handoff` ouvre l'onglet du handoff et lance sa génération. */
  startWith?: 'discussion' | 'handoff'
  onClose: () => void
  onDraft: (handoffMd: string) => void
}

function downloadDocument(artifact: Pick<HandoffDocument, 'contentMd' | 'filename'>): void {
  const blob = new Blob([artifact.contentMd], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = artifact.filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

export function HandoffModal({ conversation, startWith = 'discussion', onClose, onDraft }: HandoffModalProps) {
  const [activeDocument, setActiveDocument] = useState<'discussion' | 'handoff'>(startWith)
  const [discussion, setDiscussion] = useState<DiscussionDocument | null>(null)
  const [discussionError, setDiscussionError] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<HandoffDocument | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const autoStarted = useRef(false)
  const [copied, setCopied] = useState<'discussion' | 'handoff' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    void getDiscussionDocument(conversation.id)
      .then((document) => { if (!ignore) setDiscussion(document) })
      .catch((loadError: unknown) => { if (!ignore) setDiscussionError(errorMessage(loadError)) })
    return () => { ignore = true }
  }, [conversation.id])

  useEffect(() => {
    if (startWith !== 'handoff' || autoStarted.current) return
    autoStarted.current = true
    void handleGenerate()
  })

  async function handleGenerate() {
    if (isGenerating) return
    setIsGenerating(true)
    setError(null)
    try {
      setHandoff(await createHandoffDocument(conversation.id))
    } catch (generationError: unknown) {
      setError(errorMessage(generationError))
    } finally {
      setIsGenerating(false)
    }
  }

  async function retryDiscussion() {
    setDiscussionError(null)
    try {
      setDiscussion(await getDiscussionDocument(conversation.id))
    } catch (loadError: unknown) {
      setDiscussionError(errorMessage(loadError))
    }
  }

  async function handleCopy(document: DiscussionDocument | HandoffDocument, kind: 'discussion' | 'handoff') {
    try {
      await copyText(document.contentMd)
      setCopied(kind)
      window.setTimeout(() => setCopied(null), 1_500)
    } catch (copyError: unknown) {
      setError(errorMessage(copyError))
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => { if (!isGenerating) onClose() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isGenerating) onClose()
      }}
    >
      <section
        className="handoff-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="handoff-modal-header">
          <div>
            <h2 id="handoff-title">Handoff de session</h2>
            <p>Prépare le transfert complet de la session vers une nouvelle conversation.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Fermer"
            disabled={isGenerating}
          >
            ×
          </button>
        </header>

        <div className="handoff-document-tabs" role="tablist" aria-label="Documents de transfert">
          <button type="button" role="tab" aria-selected={activeDocument === 'discussion'} onClick={() => setActiveDocument('discussion')}>Discussion complète</button>
          <button type="button" role="tab" aria-selected={activeDocument === 'handoff'} onClick={() => setActiveDocument('handoff')}>Handoff généré</button>
        </div>

        {activeDocument === 'discussion' ? (
          <div className="handoff-modal-body">
            {discussion ? (
              <>
                <div className="handoff-preview" aria-label="Aperçu de la discussion complète">
                  <Markdown>{discussion.contentMd}</Markdown>
                </div>
                <div className="handoff-modal-actions handoff-export-actions">
                  <button type="button" className="secondary-button" onClick={() => void handleCopy(discussion, 'discussion')}>
                    {copied === 'discussion' ? 'Copié' : 'Copier la discussion'}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => downloadDocument(discussion)}>Enregistrer</button>
                </div>
              </>
            ) : discussionError ? (
              <div>
                <p className="modal-error" role="alert">{discussionError}</p>
                <button type="button" className="secondary-button" onClick={() => void retryDiscussion()}>Réessayer</button>
              </div>
            ) : (
              <p className="handoff-modal-note">Chargement de la discussion…</p>
            )}
          </div>
        ) : handoff === null ? (
          <div className="handoff-modal-body">
            <p className="handoff-modal-note">Génère une synthèse opérationnelle pour reprendre le travail dans une nouvelle conversation.</p>
            <div className="handoff-modal-actions">
              <button type="button" className="primary-button" onClick={() => void handleGenerate()} disabled={isGenerating}>
                {isGenerating ? 'Génération…' : 'Générer le handoff'}
              </button>
            </div>
            {error !== null ? <p className="modal-error" role="alert">{error}</p> : null}
          </div>
        ) : (
          <div className="handoff-modal-body">
            <div className="handoff-preview" aria-label="Aperçu du document de handoff">
              <Markdown>{handoff.contentMd}</Markdown>
            </div>

            <div className="handoff-modal-actions handoff-export-actions">
              <button type="button" className="secondary-button" onClick={() => void handleCopy(handoff, 'handoff')}>
                {copied === 'handoff' ? 'Copié' : 'Copier'}
              </button>
              <button type="button" className="secondary-button" onClick={() => downloadDocument(handoff)}>
                Enregistrer
              </button>
            </div>

            <p className="handoff-modal-note">Le handoff est posé dans le composer d’une nouvelle conversation, sans l’envoyer : ajoute tes consignes en dessous.</p>

            {error !== null ? <p className="modal-error" role="alert">{error}</p> : null}

            <footer className="handoff-modal-footer">
              <button type="button" className="secondary-button" onClick={onClose}>
                Fermer
              </button>
              <button type="button" className="primary-button" onClick={() => onDraft(handoff.contentMd)}>
                Préparer la nouvelle conversation
              </button>
            </footer>
          </div>
        )}

      </section>
    </div>
  )
}
