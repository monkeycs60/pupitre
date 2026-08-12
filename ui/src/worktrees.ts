import type { GitWorktree } from './types'

export interface WorktreeRow {
  worktree: GitWorktree
  /** Le dépôt principal : jamais supprimable, toujours en tête. */
  main: boolean
  /** Branche entièrement fusionnée : sa suppression ne perd rien. */
  merged: boolean
  /** Le worktree de la conversation ouverte. */
  current: boolean
}

/**
 * Assemble la liste affichée par l'atelier Git. Le dépôt principal ouvre la
 * liste et n'est jamais proposé à la suppression ; le reste suit l'ordre rendu
 * par git, qui est stable.
 */
export function worktreeRows(
  worktrees: GitWorktree[],
  merged: GitWorktree[],
  currentPath: string | null,
): WorktreeRow[] {
  const mergedPaths = new Set(merged.map((item) => item.path))
  const rows = worktrees.map((worktree, index) => ({
    worktree,
    // git liste toujours le dépôt principal en premier.
    main: index === 0,
    merged: mergedPaths.has(worktree.path),
    current: currentPath !== null && worktree.path === currentPath,
  }))
  return rows
}

/** Un worktree ne se retire que s'il n'est ni le dépôt, ni celui où l'on est. */
export function isRemovable(row: WorktreeRow): boolean {
  return !row.main && !row.current
}

/** Étiquette lisible d'un worktree : sa branche, ou son état détaché. */
export function worktreeLabel(worktree: GitWorktree): string {
  if (worktree.branch !== null) return worktree.branch
  return worktree.detached ? 'HEAD détachée' : worktree.path
}
