import { useState } from 'react'
import { openConversationInEditor } from './api'
import { pushToast } from './toasts'
import { VscodeGlyph } from './Icon'

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
      className="vscode-button"
      onClick={() => void open()}
      disabled={opening}
      title="Ouvrir le worktree de la conversation dans une nouvelle fenêtre VS Code"
      aria-label="Ouvrir dans VS Code"
    >
      <VscodeGlyph />
      VS Code
    </button>
  )
}
