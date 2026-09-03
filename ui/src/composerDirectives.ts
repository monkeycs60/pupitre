export interface ComposerDirectiveDefinition {
  id: string
  label: string
  detail: string
}

export const COMPOSER_DIRECTIVES = [
  {
    id: 'sidequest',
    label: 'sidequest',
    detail: 'Lancer une conversation indépendante sur la même branche et le même worktree',
  },
] as const satisfies readonly ComposerDirectiveDefinition[]
