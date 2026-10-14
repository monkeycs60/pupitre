import { useState } from 'react'
import { listConversationReferences } from './api'

const MENTION = /(^|\s)@\[([^\]\n]{1,200})\]/gu

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}

export function splitConversationMentions(text: string): Array<string | { title: string }> {
  const parts: Array<string | { title: string }> = []
  let cursor = 0
  for (const match of text.matchAll(MENTION)) {
    const start = match.index + match[1]!.length
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push({ title: match[2]!.trim() })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function ConversationMention({ title }: { title: string }) {
  const [missing, setMissing] = useState(false)

  async function open() {
    const matches = await listConversationReferences(title, 5).catch(() => [])
    const match = matches.find((item) => normalized(item.title) === normalized(title))
    if (!match) {
      setMissing(true)
      return
    }
    window.dispatchEvent(new CustomEvent('pupitre:open-conversation', { detail: { conversationId: match.id } }))
  }

  return (
    <button
      type="button"
      className={`conversation-mention${missing ? ' is-missing' : ''}`}
      title={missing ? 'Conversation introuvable' : 'Ouvrir la conversation'}
      onClick={() => void open()}
    >
      @{title}
    </button>
  )
}

export function ConversationMentionText({ text }: { text: string }) {
  return (
    <p>
      {splitConversationMentions(text).map((part, index) => typeof part === 'string'
        ? part
        : <ConversationMention key={index} title={part.title} />)}
    </p>
  )
}
