import { spawnGroup, killGroup } from "./process-group";
export interface CommandResult {
  output: string;
  exitCode: number;
  durationMs: number;
}
export function executeCommand(
  command: string,
  cwd: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawnGroup("/bin/sh", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let head = "",
      tail = "";
    const append = (data: Buffer) => {
      const text = data.toString();
      if (head.length < 16000) head = (head + text).slice(0, 16000);
      tail = (tail + text).slice(-16000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      killGroup(child, "SIGKILL");
      resolve({
        output: head === tail ? head : head + "\n[…]\n" + tail,
        exitCode: code ?? 124,
        durationMs: Date.now() - started,
      });
    });
  });
}
export const ROUTINE_TEMPLATES = [
  {
    name: "Santé du projet",
    kind: "command",
    schedule: "0 8 * * 1-5",
    command: "",
    prompt: null,
  },
  {
    name: "Audit des dépendances",
    kind: "prompt",
    schedule: "0 9 * * 1",
    command: null,
    prompt:
      "Vérifie les dépendances obsolètes ou vulnérables et propose les mises à jour utiles, sans modifier le projet.",
  },
  {
    name: "Devlog du vendredi",
    kind: "prompt",
    schedule: "0 17 * * 5",
    command: null,
    prompt:
      "Rédige et publie le devlog des sept derniers jours, à partir des chantiers et des commits du projet.",
  },
  {
    name: "Commande nocturne",
    kind: "command",
    schedule: "0 2 * * *",
    command: "",
    prompt: null,
  },
  {
    name: "Vérification de prod",
    kind: "command",
    schedule: "*/5 * * * *",
    command: "",
    prompt: null,
  },
] as const;
