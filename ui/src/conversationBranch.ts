import type { Conversation } from './types'

/**
 * Ce qu'une ligne de conversation affiche sous son titre.
 *
 * La branche remplace le preset **uniquement** quand la conversation vit dans
 * un worktree. Une conversation sur le dépôt principal — le cas courant —
 * n'apprendrait rien de « master » répété partout, et perdrait au passage son
 * preset, qui lui est utile. La ligne reste donc une information, jamais un
 * décor.
 */
export interface ConversationSubtitle {
  kind: 'branch' | 'preset'
  label: string
}

export function conversationSubtitle(
  conversation: Partial<Pick<Conversation, 'worktree_path'>>,
  presetLabel: string,
): ConversationSubtitle {
  const branch = branchOfWorktree(conversation.worktree_path)
  return branch === null
    ? { kind: 'preset', label: presetLabel }
    : { kind: 'branch', label: branch }
}

/**
 * Le nom de branche déduit du chemin du worktree. Pupitre range ses worktrees
 * en `<racine>/<projet>/<branche>`, et aplatit les `/` d'un nom de branche en
 * `-` à la création : le dernier segment est donc lisible tel quel.
 */
export function branchOfWorktree(worktreePath: string | null | undefined): string | null {
  // `undefined` arrive d'une réponse qui ne porte pas encore le champ : le
  // traiter comme « pas de worktree » plutôt que de casser le rendu.
  if (worktreePath === null || worktreePath === undefined || worktreePath.trim() === '') return null
  const segments = worktreePath.split('/').filter(Boolean)
  return segments.at(-1) ?? null
}
