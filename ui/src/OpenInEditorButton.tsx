import { useState } from 'react'
import { openConversationInEditor } from './api'
import { pushToast } from './toasts'

export function OpenInEditorButton({ conversationId }: { conversationId: string }) {
  const [opening, setOpening] = useState(false)

  async function open() {
    setOpening(true)
    try {
      const { folders } = await openConversationInEditor(conversationId)
      pushToast({
        tone: 'ok',
        title: 'VS Code ouvert dans une nouvelle fenêtre',
        detail: folders
          .filter((folder) => folder.branch !== null)
          .map((folder) => `${folder.name} · ${folder.branch}`)
          .join(', '),
      })
    } catch (error) {
      pushToast({
        tone: 'danger',
        title: 'Ouverture de VS Code impossible',
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setOpening(false)
    }
  }

  return (
    <button
      type="button"
      className="header-action header-action-icon"
      onClick={() => void open()}
      disabled={opening}
      title="Ouvrir le worktree de la conversation dans une nouvelle fenêtre VS Code"
      aria-label="Ouvrir dans VS Code"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
