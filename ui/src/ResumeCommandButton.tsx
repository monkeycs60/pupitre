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

  return (
    <button
      type="button"
      className="header-action"
      onClick={() => {
        void copyText(command)
          .then(() => setState('copied'))
          .catch(() => setState('error'))
      }}
      title={`Copier la commande pour reprendre cette session dans un terminal : ${command}. Voir Aide > Reprise terminal.`}
    >
      {state === 'copied' ? 'Commande copiée' : state === 'error' ? 'Copie impossible' : 'Reprendre au terminal'}
    </button>
  )
}
