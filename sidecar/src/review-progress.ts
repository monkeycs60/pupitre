import type { ReviewComment } from "./stores/review-comments";

export type ReviewProgress = "treated" | "file-changed" | "pending";

/**
 * Lit un `git diff -U0` entre le code au moment de l'envoi et le code
 * actuel : un hunk qui recouvre les lignes commentées vaut « traité », un
 * diff ailleurs dans le fichier « fichier modifié », rien « en attente ».
 * Les lignes d'un commentaire côté « old » (supprimées par le diff relu)
 * n'existent plus dans l'état d'envoi : seul le fichier peut être jugé.
 */
export function progressFromDiff(diff: string, side: "new" | "old", startLine: number, endLine: number): ReviewProgress {
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)];
  if (hunks.length === 0) return "pending";
  if (side === "old") return "file-changed";
  const touched = hunks.some((hunk) => {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const last = count === 0 ? start + 1 : start + count - 1;
    return start <= endLine && last >= startLine;
  });
  return touched ? "treated" : "file-changed";
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? output : null;
}

/**
 * État du worktree au moment de l'envoi. Les lignes commentées suivent le
 * code tel qu'il était sur le disque, non commité compris : `git stash
 * create` le fige en commit sans toucher au worktree ; HEAD s'il n'y a rien
 * de non commité.
 */
export async function snapshotOf(worktreePath: string): Promise<string | null> {
  const stash = (await git(worktreePath, ["stash", "create"]))?.trim();
  return stash || (await git(worktreePath, ["rev-parse", "HEAD"]))?.trim() || null;
}

/** Avancement d'un commentaire envoyé, commits et changements non commités compris ; nul pour un brouillon. */
export async function reviewProgress(comment: ReviewComment): Promise<ReviewProgress | null> {
  if (comment.status !== "sent" || !comment.head_at_send) return null;
  const diff = await git(comment.worktree_path, ["diff", "-U0", "--no-color", "--no-ext-diff", comment.head_at_send, "--", comment.path]);
  return diff === null ? null : progressFromDiff(diff, comment.side, comment.start_line, comment.end_line);
}
