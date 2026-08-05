import type { AppEvent } from './types'

export function latestUserText(events: AppEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'user-message') return event.text
  }
  return ''
}

export function withSkillInvocation(message: string, invocation: string): string {
  const token = `$${invocation}`
  if (message.includes(token)) return message
  return message.trim() ? `${token}\n\n${message}` : `${token} `
}
