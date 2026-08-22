import type { Conversation } from './types'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function resumeCommand(conversation: Conversation): string | null {
  if (!conversation.cli_session_id) return null
  if (conversation.provider === 'claude') {
    return `claude --resume ${shellQuote(conversation.cli_session_id)}`
  }
  if (conversation.provider === 'grok') {
    return `grok --resume ${shellQuote(conversation.cli_session_id)}`
  }
  return `codex resume ${shellQuote(conversation.cli_session_id)}`
}
