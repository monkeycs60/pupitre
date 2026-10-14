export interface ComposerDirectiveDefinition {
  id: string
  label: string
  detail: string
}

export const COMPOSER_DIRECTIVES = [
  {
    id: 'code',
    label: 'code',
    detail: 'Expliquer le code avec des fichiers navigables et des lignes surlignées',
  },
  {
    id: 'sidequest',
    label: 'sidequest',
    detail: 'Lancer une conversation indépendante sur la même branche et le même worktree',
  },
] as const satisfies readonly ComposerDirectiveDefinition[]
