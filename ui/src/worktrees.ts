import type { GitBranch, GitWorktree } from './types'

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

/**
 * Les worktrees dont la suppression ne coûte rien : leur branche est fusionnée
 * et personne n'y travaille. Le dépôt principal et le worktree courant en sont
 * exclus par `isRemovable`.
 */
export function disposableWorktrees(rows: WorktreeRow[]): WorktreeRow[] {
  return rows.filter((row) => row.merged && isRemovable(row))
}

/**
 * L'invite de nettoyage, ou null s'il n'y a rien à proposer. L'ADR prévoit de
 * *proposer* la suppression après fusion : la marquer ne suffit pas, il faut le
 * dire.
 */
export function cleanupInvitation(rows: WorktreeRow[]): string | null {
  const count = disposableWorktrees(rows).length
  if (count === 0) return null
  return count === 1
    ? '1 branche fusionnée : son worktree peut être retiré.'
    : `${count} branches fusionnées : leurs worktrees peuvent être retirés.`
}

/**
 * Les branches proposées à la saisie. Les locales d'abord, puis les distantes
 * qui n'ont pas d'équivalent local — celles qu'on veut justement rejoindre.
 * Sans cette liste, une faute de frappe crée une branche jumelle au lieu de
 * rejoindre la bonne.
 */
export function branchSuggestions(branches: GitBranch[]): string[] {
  const local = branches.filter((branch) => !branch.remote).map((branch) => branch.name)
  const seen = new Set(local)
  const remote = branches
    // `refs/remotes/origin/HEAD` est un alias, pas une branche — et il est
    // exposé sous le nom « origin », que filtrer sur « HEAD » ne rattrape pas.
    .filter((branch) => branch.remote && !branch.fullName.endsWith('/HEAD'))
    .flatMap((branch) => {
      const separator = branch.name.indexOf('/')
      // Un nom sans « / » ne désigne pas une branche distante suivable.
      return separator === -1 ? [] : [branch.name.slice(separator + 1)]
    })
    .filter((name) => name !== '' && !seen.has(name))
  return [...local, ...new Set(remote)]
}
