// Importé tel quel par le sidecar (sidecar/src/stores/ui-events.ts) : aucun
// import ni API du navigateur ici, sinon son typecheck et son build cassent.
export const USAGE_AREAS = ['Navigation', 'Projet', 'Liste', 'Conversation', 'Serveurs', 'Jarvis', 'Réglages'] as const
export type UsageArea = (typeof USAGE_AREAS)[number]

export interface UsageFeature {
  feature: string
  event: string
  label: string
  area: UsageArea
  match?: { prop: string; value: string }
}

const CATALOG = [
  { feature: 'nav.home', event: 'nav.home', label: 'Accueil', area: 'Navigation' },
  { feature: 'nav.report', event: 'nav.report', label: 'Rapport', area: 'Navigation' },
  { feature: 'nav.settings', event: 'nav.settings', label: 'Réglages', area: 'Navigation' },
  { feature: 'design.open', event: 'design.open', label: 'Design', area: 'Navigation' },
  { feature: 'palette.open', event: 'palette.open', label: 'Palette de commandes', area: 'Navigation' },
  { feature: 'palette.command', event: 'palette.command', label: 'Commande de la palette', area: 'Navigation' },
  { feature: 'shortcut', event: 'shortcut', label: 'Raccourci clavier', area: 'Navigation' },
  { feature: 'project.tab.conversations', event: 'project.tab', match: { prop: 'tab', value: 'conversations' }, label: 'Onglet Conversations', area: 'Projet' },
  { feature: 'project.tab.tickets', event: 'project.tab', match: { prop: 'tab', value: 'tickets' }, label: 'Onglet Tickets', area: 'Projet' },
  { feature: 'project.tab.tasks', event: 'project.tab', match: { prop: 'tab', value: 'tasks' }, label: 'Onglet Tâches', area: 'Projet' },
  { feature: 'project.tab.sentry', event: 'project.tab', match: { prop: 'tab', value: 'sentry' }, label: 'Onglet Sentry', area: 'Projet' },
  { feature: 'conversation.open', event: 'conversation.open', label: 'Ouvrir une conversation', area: 'Liste' },
  { feature: 'conversation.new', event: 'conversation.new', label: 'Nouvelle conversation', area: 'Liste' },
  { feature: 'conversation.pin', event: 'conversation.pin', label: 'Épingler une conversation', area: 'Liste' },
  { feature: 'conversation.archive', event: 'conversation.archive', label: 'Archiver une conversation', area: 'Liste' },
  { feature: 'list.tidy', event: 'list.tidy', label: 'Ranger la liste', area: 'Liste' },
  { feature: 'list.filter', event: 'list.filter', label: 'Filtrer la liste', area: 'Liste' },
  { feature: 'list.ai-search', event: 'list.ai-search', label: 'Recherche IA', area: 'Liste' },
  { feature: 'header.vscode', event: 'header.vscode', label: 'Ouvrir dans VS Code', area: 'Conversation' },
  { feature: 'header.menu', event: 'header.menu', label: 'Menu de la conversation', area: 'Conversation' },
  { feature: 'thread.search', event: 'thread.search', label: 'Recherche dans le fil', area: 'Conversation' },
  { feature: 'thread.attachments', event: 'thread.attachments', label: 'Pièces jointes du fil', area: 'Conversation' },
  { feature: 'composer.send', event: 'composer.send', label: 'Envoyer un message', area: 'Conversation' },
  { feature: 'servers.expand', event: 'servers.expand', label: 'Déplier les serveurs', area: 'Serveurs' },
  { feature: 'servers.open', event: 'servers.open', label: 'Ouvrir un serveur', area: 'Serveurs' },
  { feature: 'servers.restart', event: 'servers.restart', label: 'Redémarrer un serveur', area: 'Serveurs' },
  { feature: 'servers.logs', event: 'servers.logs', label: 'Journaux d’un serveur', area: 'Serveurs' },
  { feature: 'jarvis.open', event: 'jarvis.open', label: 'Ouvrir Jarvis', area: 'Jarvis' },
  { feature: 'jarvis.ask', event: 'jarvis.ask', label: 'Question à Jarvis', area: 'Jarvis' },
  { feature: 'jarvis.action', event: 'jarvis.action', label: 'Action de Jarvis', area: 'Jarvis' },
  { feature: 'settings.text-size', event: 'settings.text-size', label: 'Taille du texte', area: 'Réglages' },
] as const satisfies readonly UsageFeature[]

export type UiEventName = (typeof CATALOG)[number]['event']

export const USAGE_CATALOG: ReadonlyArray<UsageFeature & { event: UiEventName }> = CATALOG

export type ProjectTab = 'conversations' | 'tickets' | 'tasks' | 'sentry'

export type UiEventPropValue = string | number | boolean

export interface UiEventPropsByName {
  'project.tab': { tab: ProjectTab }
  'palette.command': { command: string }
  shortcut: { key: string }
  'jarvis.ask': { mode: string; model: string; by: string; escalated: boolean; status: string; seconds: number; results: number; proposed: string }
  'jarvis.action': { kind: string; result: string }
}

export type UiEventProps<N extends UiEventName> = N extends keyof UiEventPropsByName
  ? UiEventPropsByName[N]
  : Record<string, UiEventPropValue>
