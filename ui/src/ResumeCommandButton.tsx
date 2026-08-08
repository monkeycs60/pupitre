import { useState } from 'react'
import type { Conversation } from './types'
import { resumeCommand } from './resumeCommand'

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const input = document.createElement('textarea')
  input.value = text
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('copie refusée')
}

export function ResumeCommandButton({ conversation }: { conversation: Conversation }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const command = resumeCommand(conversation)
  if (!command) return null

  const label = state === 'copied'
    ? 'Commande copiée'
    : state === 'error'
      ? 'Copie impossible'
      : 'Reprendre au terminal'

  return (
    <button
      type="button"
      className="header-action header-action-icon"
      onClick={() => {
        void copyText(command)
          .then(() => setState('copied'))
          .catch(() => setState('error'))
      }}
      title={`${label} — copie la commande : ${command}. Voir Aide > Reprise terminal.`}
      aria-label={label}
    >
      {state === 'copied' ? (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5 6 8l-3 3.5" />
            <path d="M8 12h5" />
          </g>
        </svg>
      )}
    </button>
  )
}
