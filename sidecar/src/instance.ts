import { homedir } from "node:os";
import { join } from "node:path";

export type InstanceName = "stable" | "dev";
export interface InstanceInfo { name: InstanceName; port: number; dataDir: string }

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
