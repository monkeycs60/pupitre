import type { Conversation } from './types'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function resumeCommand(conversation: Conversation): string | null {
  if (!conversation.cli_session_id) return null
  return conversation.provider === 'claude'
    ? `claude --resume ${shellQuote(conversation.cli_session_id)}`
    : `codex resume ${shellQuote(conversation.cli_session_id)}`
}
