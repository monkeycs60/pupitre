import {
  cancelConversation,
  createConversation,
  sendMessage,
  setConversationArchived,
  setConversationPinned,
} from './api'
import { readLaunchConfig } from './configMemory'
import { openExternal } from './externalLink'
import { PROVIDER_DEFAULTS } from './modelOptions'
import type { JarvisAction } from './types'

export { askJarvis, cancelJarvisJob, getJarvisJob } from './api'

/** Ce qui change concrètement si l'action est exécutée : affiché avant la confirmation. */
export function actionEffect(action: JarvisAction): string {
  switch (action.kind) {
    case 'open': return action.eventIds.length > 0
      ? `Ouvre la conversation et surligne ${action.eventIds.length} passage${action.eventIds.length > 1 ? 's' : ''}.`
      : 'Ouvre la conversation.'
    case 'send-message': return 'Envoie ce message à l’agent, qui reprend la main tout de suite.'
    case 'new-conversation': return 'Démarre une nouvelle conversation avec ce premier message, dans le projet indiqué.'
    case 'archive': return `Archive ${action.conversationIds.length} conversation${action.conversationIds.length > 1 ? 's' : ''} ; elles restent cherchables dans Archives.`
    case 'pin': return action.pinned ? 'Épingle la conversation en haut de la liste.' : 'Retire l’épingle.'
    case 'stop': return 'Interrompt le tour en cours de l’agent.'
    case 'open-url': return `Ouvre ${action.url} dans le navigateur.`
  }
}

/** Les actions qui ne font que montrer quelque chose s'exécutent sans confirmation. */
export function actionIsHarmless(action: JarvisAction): boolean {
  return action.kind === 'open' || action.kind === 'open-url'
}

export interface JarvisActionContext {
  openConversation: (projectId: string, conversationId: string, eventIds: number[]) => Promise<void>
  refreshConversations: () => void
  /** La route de création attend l'identifiant du ticket, Jarvis n'en connaît que la clé. */
  resolveTicketId: (projectId: string, ticketKey: string) => Promise<string | null>
}

/** Exécute une action confirmée par l'utilisateur ; renvoie un compte rendu court. */
export async function executeJarvisAction(
  action: JarvisAction,
  edits: { message?: string; prompt?: string },
  context: JarvisActionContext,
): Promise<string> {
  switch (action.kind) {
    case 'open':
      await context.openConversation(action.projectId, action.conversationId, action.eventIds)
      return 'Conversation ouverte'
    case 'send-message': {
      const message = (edits.message ?? action.message).trim()
      if (message === '') throw new Error('Le message est vide.')
      await sendMessage(action.conversationId, { message })
      context.refreshConversations()
      return 'Message envoyé'
    }
    case 'new-conversation': {
      const prompt = (edits.prompt ?? action.prompt).trim()
      if (prompt === '') throw new Error('Le premier message est vide.')
      const remembered = readLaunchConfig(action.projectId)
      const ticketId = action.ticketKey ? await context.resolveTicketId(action.projectId, action.ticketKey) : null
      const conversation = await createConversation({
        projectId: action.projectId,
        ticketId,
        presetId: remembered?.presetId ?? null,
        provider: remembered?.provider ?? 'claude',
        model: remembered?.model ?? PROVIDER_DEFAULTS.claude.model,
        effort: remembered?.effort ?? PROVIDER_DEFAULTS.claude.effort,
        speed: remembered?.speed,
        permissionMode: remembered?.permissionMode ?? null,
        message: prompt,
      })
      context.refreshConversations()
      await context.openConversation(action.projectId, conversation.id, [])
      return 'Conversation démarrée'
    }
    case 'archive': {
      for (const conversationId of action.conversationIds) await setConversationArchived(conversationId, true)
      context.refreshConversations()
      return `${action.conversationIds.length} archivée${action.conversationIds.length > 1 ? 's' : ''}`
    }
    case 'pin':
      await setConversationPinned(action.conversationId, action.pinned)
      context.refreshConversations()
      return action.pinned ? 'Épinglée' : 'Épingle retirée'
    case 'stop':
      await cancelConversation(action.conversationId)
      context.refreshConversations()
      return 'Tour interrompu'
    case 'open-url':
      await openExternal(action.url)
      return 'Ouvert dans le navigateur'
  }
}
