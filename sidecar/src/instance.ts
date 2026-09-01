import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type InstanceName = "stable" | "dev";
export interface InstanceInfo { name: InstanceName; port: number; dataDir: string }
export interface BuildInfo { sha: string; dirty: boolean; source: "build" | "git" }

const repositoryRoot = join(import.meta.dir, "..", "..");
const embeddedBuildSha = process.env.PUPITRE_BUILD_SHA;
const embeddedBuildDirty = process.env.PUPITRE_BUILD_DIRTY;
let cachedBuildInfo: BuildInfo | undefined;
let staleCache: { startedAt: number; checkedAt: number; count: number } | undefined;

export function defaultPort(name: InstanceName): number {
  return name === "dev" ? 4821 : 4820;
}

export function defaultDataDir(name: InstanceName, home = homedir()): string {
  return join(home, ".local/share", name === "dev" ? "pupitre-dev" : "pupitre");
}

export function readInstance(env: NodeJS.ProcessEnv = process.env): InstanceInfo {
  const raw = env.PUPITRE_INSTANCE ?? "stable";
  if (raw !== "stable" && raw !== "dev") throw new Error(`PUPITRE_INSTANCE invalide : ${raw}`);
  const port = env.PUPITRE_PORT === undefined ? defaultPort(raw) : Number(env.PUPITRE_PORT);
  if (env.PUPITRE_PORT?.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PUPITRE_PORT invalide");
  }
  return { name: raw, port, dataDir: env.PUPITRE_DATA_DIR ?? defaultDataDir(raw, env.HOME ?? homedir()) };
}

export function backgroundJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PUPITRE_BACKGROUND_JOBS === "on") return true;
  if (env.PUPITRE_BACKGROUND_JOBS === "off") return false;
  return readInstance(env).name === "stable";
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env, root = repositoryRoot): BuildInfo {
  const useCache = env === process.env && root === repositoryRoot;
  if (useCache && cachedBuildInfo) return cachedBuildInfo;
  const buildSha = env === process.env ? embeddedBuildSha : env.PUPITRE_BUILD_SHA;
  const buildDirty = env === process.env ? embeddedBuildDirty : env.PUPITRE_BUILD_DIRTY;
  let result: BuildInfo;
  if (buildSha) {
    result = {
      sha: buildSha,
      dirty: buildDirty === "1",
      source: "build",
    };
  } else {
    const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
    const statusPaths = root === repositoryRoot ? ["sidecar", "ui", "src-tauri"] : ["."];
    const status = Bun.spawnSync(["git", "status", "--porcelain", "--", ...statusPaths], { cwd: root });
    result = {
      sha: sha.exitCode === 0 ? sha.stdout.toString().trim() : "inconnu",
      dirty: status.exitCode === 0 && status.stdout.length > 0,
      source: "git",
    };
  }
  if (useCache) cachedBuildInfo = result;
  return result;
}

export function staleSourcesSince(
  startedAt: number,
  sourceDir = join(repositoryRoot, "sidecar", "src"),
  build = buildInfo(),
): number {
  if (build.source === "build") return 0;
  const now = Date.now();
  const useCache = sourceDir === join(repositoryRoot, "sidecar", "src");
  if (useCache && staleCache?.startedAt === startedAt && now - staleCache.checkedAt < 3_000) {
    return staleCache.count;
  }
  let count = 0;
  try {
    for (const relativePath of readdirSync(sourceDir, { recursive: true, encoding: "utf8" })) {
      if (!relativePath.endsWith(".ts")) continue;
      if (statSync(join(sourceDir, relativePath)).mtimeMs > startedAt) count += 1;
    }
  } catch {
    count = 0;
  }
  if (useCache) staleCache = { startedAt, checkedAt: now, count };
  return count;
}
