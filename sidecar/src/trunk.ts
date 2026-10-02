import { isBaseBranch } from "./ticket-key";

const cache = new Map<string, { branch: string | null; expires: number }>();

function git(repository: string, args: string[]): string | null {
  try {
  const result = Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch { return null; }
}

export function trunkOf(repository: string, override?: string | null): string | null {
  if (override?.trim()) return override.trim();
  const cached = cache.get(repository);
  if (cached && cached.expires > Date.now()) return cached.branch;
  const remote = git(repository, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const branch = remote?.replace(/^refs\/remotes\/origin\//u, "")
    ?? ["main", "master", "develop"].find((name) => git(repository, ["show-ref", "--verify", `refs/heads/${name}`]) !== null)
    ?? null;
  cache.set(repository, { branch, expires: Date.now() + 600_000 });
  return branch;
}

export function isTrunkRef(repository: string, ref: string, override?: string | null): boolean {
  const remotes = git(repository, ["remote"])?.split("\n") ?? [];
  let branch = ref.trim().replace(/^refs\/heads\//u, "").replace(/^refs\/remotes\/[^/]+\//u, "");
  const remote = remotes.find((name) => branch.startsWith(`${name}/`));
  if (remote) branch = branch.slice(remote.length + 1);
  return isBaseBranch(branch) || branch === trunkOf(repository, override);
}
