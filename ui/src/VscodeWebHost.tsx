import { useEffect, useState } from 'react'
import { getVscodeWebUrl } from './api'
import { httpUrl } from './transport'
import './styles/vscode-web.css'

const KEPT_EDITORS = 3

interface Editor {
  conversationId: string
  url: string | null
  error: string | null
  usedAt: number
}

/**
 * Ajoute ou rafraîchit l'éditeur d'une conversation sans réordonner les
 * autres : une iframe déplacée dans le DOM se recharge et perd son état.
 */
function touch(editors: Editor[], conversationId: string): Editor[] {
  const now = Date.now()
  const known = editors.some((editor) => editor.conversationId === conversationId)
  const next = known
    ? editors.map((editor) => (editor.conversationId === conversationId ? { ...editor, usedAt: now, error: null } : editor))
    : [...editors, { conversationId, url: null, error: null, usedAt: now }]
  if (next.length <= KEPT_EDITORS) return next
  const oldest = next.reduce((least, editor) => (editor.usedAt < least.usedAt ? editor : least))
  return next.filter((editor) => editor !== oldest)
}

/**
 * VS Code dans Pupitre : un panneau par conversation, gardé monté et
 * seulement masqué quand on revient au fil, pour que le passage de l'un à
 * l'autre soit immédiat et que l'éditeur garde ses onglets.
 */
export function VscodeWebHost({ active, conversationId, onBackToConversation }: { active: boolean, conversationId: string | null, onBackToConversation: () => void }) {
  const [editors, setEditors] = useState<Editor[]>([])

  useEffect(() => {
    const origins = new Set(editors.flatMap((editor) => {
      if (editor.url === null) return []
      try { return [new URL(httpUrl(editor.url), location.href).origin] } catch { return [] }
    }))
    const back = (event: MessageEvent) => {
      if (event.data?.type === 'pupitre:conversation' && origins.has(event.origin)) onBackToConversation()
    }
    window.addEventListener('message', back)
    return () => window.removeEventListener('message', back)
  }, [editors, onBackToConversation])

  useEffect(() => {
    if (!active || conversationId === null) return
    const ready = editors.some((editor) => editor.conversationId === conversationId && editor.url !== null)
    setEditors((current) => touch(current, conversationId))
    if (ready) return
    let cancelled = false
    getVscodeWebUrl(conversationId)
      .then(({ url }) => {
        if (!cancelled) setEditors((current) => current.map((editor) => (editor.conversationId === conversationId ? { ...editor, url } : editor)))
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          const error = reason instanceof Error ? reason.message : String(reason)
          setEditors((current) => current.map((editor) => (editor.conversationId === conversationId ? { ...editor, error } : editor)))
        }
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, conversationId])

  if (editors.length === 0 && !active) return null
  const current = editors.find((editor) => editor.conversationId === conversationId) ?? null
  return <div className="vscode-web-host" hidden={!active}>
    {active && conversationId === null ? <p className="vscode-web-message">Ouvre une conversation pour afficher son worktree dans VS Code.</p> : null}
    {active && current?.error ? <p className="vscode-web-message is-error">VS Code indisponible : {current.error}</p> : null}
    {active && current && current.url === null && current.error === null ? (
      <p className="vscode-web-message">Démarrage de VS Code… le premier lancement télécharge sa version web.</p>
    ) : null}
    {editors.map((editor) => editor.url ? (
      <iframe
        key={editor.conversationId}
        className="vscode-web-frame"
        src={httpUrl(editor.url)}
        title="VS Code"
        hidden={editor.conversationId !== conversationId}
        allow="clipboard-read; clipboard-write"
      />
    ) : null)}
  </div>
}
