import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { killGroup, spawnGroup } from "../src/process-group";

/**
 * `mcp-probe` avait résolu la fuite des flottes MCP par un groupe de process,
 * et la leçon n'avait voyagé ni jusqu'aux tours provider ni jusqu'aux sondes.
 * Quatre modules lançaient le même genre de process, deux le faisaient bien.
 * Ce fichier vérifie la mesure, puis interdit qu'un cinquième reparte seul.
 */

const srcDir = join(import.meta.dir, "../src");

/** Modules qui lancent un provider ou un serveur MCP, donc une flotte. */
const LANCEURS = [
  "adapters/spawn-jsonl.ts",
  "adapters/codex-app-server.ts",
  "mcp-probe.ts",
  "mcp-verify.ts",
  "conversation-digest.ts",
];

/**
 * `quota-auth` lance un terminal graphique que l'utilisateur ferme lui-même :
 * Pupitre ne lui envoie jamais de signal, et `claude auth login` n'ouvre pas
 * de serveurs MCP.
 */
const HORS_PERIMETRE = ["quota-auth.ts"];

function sourcesDe(dir: string, prefixe = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return sourcesDe(join(dir, entry.name), `${prefixe}${entry.name}/`);
    }
    return entry.name.endsWith(".ts") ? [`${prefixe}${entry.name}`] : [];
  });
}

const lire = (relatif: string): string =>
  readFileSync(join(srcDir, relatif), "utf8");

test("les lanceurs de flotte passent tous par le groupe de process", () => {
  for (const module of LANCEURS) {
    const source = lire(module);
    expect(source, `${module} doit lancer via spawnGroup`).toContain("spawnGroup(");
    expect(source, `${module} ne doit pas appeler spawn() nu`).not.toMatch(/[^a-zA-Z]spawn\(/);
  }
});

test("aucun lanceur ne tue par le seul pid du process lancé", () => {
  for (const module of LANCEURS) {
    const source = lire(module);
    // `child.kill()` ne touche que le parent : ses serveurs MCP survivent.
    expect(source, `${module} doit tuer par groupe`).not.toMatch(/\bchild\.kill\(/);
  }
});

test("un nouveau module lanceur ne peut pas échapper à la liste", () => {
  const oublis = sourcesDe(srcDir)
    .filter((module) => !LANCEURS.includes(module) && !HORS_PERIMETRE.includes(module))
    .filter((module) => {
      const source = lire(module);
      // Les sondes et adaptateurs lancent des binaires externes ; `git` et le
      // terminal n'ont pas de flotte MCP, seuls claude/codex en ont une.
      return /[^a-zA-Z]spawn\(/.test(source)
        && /PUPITRE_(CLAUDE|CODEX|GROK)_BIN|"app-server"|definition\.command/.test(source);
    });

  expect(oublis, `à ajouter à LANCEURS et à passer par spawnGroup : ${oublis.join(", ")}`)
    .toEqual([]);
});

test("killGroup atteint les petits-enfants, pas seulement le process lancé", async () => {
  let petitFils = 0;
  const child = spawnGroup(
    "/bin/sh",
    ["-c", 'sleep 30 & printf "PID=%s\\n" "$!"; wait'],
    { cwd: "/tmp", stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      const match = String(chunk).match(/PID=(\d+)/);
      if (match) {
        petitFils = Number(match[1]);
        resolve();
      }
    });
  });

  expect(petitFils).toBeGreaterThan(0);
  expect(killGroup(child, "SIGKILL")).toBe(true);

  const limite = performance.now() + 3_000;
  let mort = false;
  while (performance.now() < limite && !mort) {
    try {
      process.kill(petitFils, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      mort = true;
    }
  }
  expect(mort).toBe(true);
}, 10_000);
