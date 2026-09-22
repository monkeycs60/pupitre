import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeTurn } from "../src/adapters/claude";
import { claudeSessions } from "../src/adapters/claude-session";
import type { AppEvent } from "../src/events";
import type { TurnOptions } from "../src/adapters/types";

/**
 * Le CLI encaisse plusieurs tours sur un seul process tant que stdin reste
 * ouvert. Ces tests comptent les LANCEMENTS, pas les tours : c'est le seul
 * moyen de distinguer une session réutilisée d'une session rejouée par `-r`.
 */

let dir: string;
let pidsFile: string;
let argsFile: string;

const lignes = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "")
    : [];

/** Nombre de process `claude` réellement lancés depuis le début du test. */
const lancements = (): number => lignes(pidsFile).length;

function options(overrides: Partial<TurnOptions> = {}): TurnOptions {
  return {
    cwd: dir,
    model: "haiku",
    prompt: "salut",
    cliSessionId: null,
    permissionMode: "default",
    images: [],
    ...overrides,
  };
}

async function tour(overrides: Partial<TurnOptions> = {}): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  await runClaudeTurn(options(overrides), (event) => events.push(event));
  return events;
}

const etat = (events: AppEvent[]): AppEvent | undefined =>
  events.findLast((event) => event.type === "status");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pupitre-session-"));
  pidsFile = join(dir, "pids");
  argsFile = join(dir, "args");
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude-persistent");
  process.env.FAKE_PERSISTENT_PIDS = pidsFile;
  process.env.FAKE_PERSISTENT_ARGS = argsFile;
  delete process.env.PUPITRE_CLAUDE_PERSISTENT;
});

afterEach(() => {
  claudeSessions.shutdown();
  delete process.env.PUPITRE_CLAUDE_BIN;
  delete process.env.FAKE_PERSISTENT_PIDS;
  delete process.env.FAKE_PERSISTENT_ARGS;
  delete process.env.PUPITRE_CLAUDE_PERSISTENT;
});

test("un second tour réutilise le process du premier", async () => {
  const premier = await tour();
  expect(etat(premier)).toEqual({ type: "status", state: "done" });
  expect(premier).toContainEqual({
    type: "session", provider: "claude", cliSessionId: "S-persistant", model: "faux",
  });
  expect(lancements()).toBe(1);

  const second = await tour({ cliSessionId: "S-persistant" });
  expect(etat(second)).toEqual({ type: "status", state: "done" });
  expect(lancements()).toBe(1);
  expect(claudeSessions.size()).toBe(1);
});

test("le process réutilisé ne reçoit pas de `-r` : il est déjà dans la session", async () => {
  await tour();
  await tour({ cliSessionId: "S-persistant" });

  expect(lignes(argsFile)).not.toContain("-r");
});

test("une session inconnue est reprise par `-r` sur un process neuf", async () => {
  await tour({ cliSessionId: "S-deja-close" });

  expect(lancements()).toBe(1);
  const args = lignes(argsFile);
  expect(args).toContain("-r");
  expect(args).toContain("S-deja-close");
});

test("un changement de modèle relance le process, qui porte l'ancien", async () => {
  await tour();
  expect(lancements()).toBe(1);

  await tour({ cliSessionId: "S-persistant", model: "opus" });

  expect(lancements()).toBe(2);
  expect(lignes(argsFile)).toContain("-r");
});

test("l'arrêt du sidecar ferme les process persistants", async () => {
  await tour();
  const pid = Number(lignes(pidsFile)[0]);
  expect(() => process.kill(pid, 0)).not.toThrow();

  claudeSessions.shutdown();
  expect(claudeSessions.size()).toBe(0);

  const limite = performance.now() + 3_000;
  let mort = false;
  while (performance.now() < limite && !mort) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      mort = true;
    }
  }
  expect(mort).toBe(true);
}, 10_000);

test("PUPITRE_CLAUDE_PERSISTENT=0 rétablit un process par tour", async () => {
  process.env.PUPITRE_CLAUDE_PERSISTENT = "0";

  await tour();
  await tour({ cliSessionId: "S-persistant" });

  expect(lancements()).toBe(2);
  expect(claudeSessions.size()).toBe(0);
});

test("un `result` émis pendant que le message attend en file ne clôt pas le tour", async () => {
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude-orphan-result");

  const events = await tour({ cliSessionId: "S-orphelin" });

  expect(events).toContainEqual({ type: "text-final", text: "vraie reponse" });
  expect(events.filter((event) => event.type === "status")).toEqual([
    { type: "status", state: "running" },
    { type: "status", state: "done" },
  ]);
});

test("PUPITRE_CLAUDE_PERSISTENT=0 attend aussi le `result` du message envoyé", async () => {
  process.env.PUPITRE_CLAUDE_PERSISTENT = "0";
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude-orphan-result");

  const events = await tour({ cliSessionId: "S-orphelin" });

  expect(events).toContainEqual({ type: "text-final", text: "vraie reponse" });
  expect(events.filter((event) => event.type === "status")).toEqual([
    { type: "status", state: "running" },
    { type: "status", state: "done" },
  ]);
});

async function attendre(condition: () => boolean, limiteMs = 3_000): Promise<void> {
  const limite = performance.now() + limiteMs;
  while (!condition() && performance.now() < limite) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function vivant(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("une réaction du CLI entre deux tours ouvre un tour autonome", async () => {
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude-background");
  process.env.FAKE_BACKGROUND_REACT = "1";
  const autonome: AppEvent[] = [];
  let ouvertures = 0;
  try {
    const premier = await tour({
      openAutonomousTurn: () => {
        ouvertures += 1;
        return (event) => autonome.push(event);
      },
    });
    expect(etat(premier)).toEqual({ type: "status", state: "done" });

    await attendre(() => autonome.some((event) => event.type === "status"));
    expect(ouvertures).toBe(1);
    expect(autonome).toEqual([
      {
        type: "background-task",
        status: "completed",
        summary: "Background command \"recette\" completed (exit code 0)",
      },
      { type: "text-final", text: "recette finie" },
      { type: "status", state: "done" },
    ]);
  } finally {
    delete process.env.FAKE_BACKGROUND_REACT;
  }
});

test("annuler un tour autonome tue le process et clôt le tour", async () => {
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude-background");
  process.env.FAKE_BACKGROUND_REACT = "1";
  const autonome: AppEvent[] = [];
  try {
    await tour({
      openAutonomousTurn: ({ cancel }) => (event) => {
        autonome.push(event);
        if (event.type === "background-task") cancel();
      },
    });
    await attendre(() => autonome.some((event) => event.type === "status"));

    expect(autonome.at(-1)).toEqual({ type: "status", state: "error", error: "annulé" });
    expect(claudeSessions.size()).toBe(0);
  } finally {
    delete process.env.FAKE_BACKGROUND_REACT;
  }
});

test("une tâche de fond en cours garde le process au-delà du délai d'inactivité", async () => {
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude-background");
  process.env.PUPITRE_CLAUDE_IDLE_MS = "100";
  process.env.PUPITRE_CLAUDE_BACKGROUND_MAX_MS = "600";
  try {
    await tour();
    const pid = Number(lignes(pidsFile)[0]);

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(vivant(pid)).toBe(true);

    await attendre(() => !vivant(pid), 3_000);
    expect(vivant(pid)).toBe(false);
  } finally {
    delete process.env.PUPITRE_CLAUDE_IDLE_MS;
    delete process.env.PUPITRE_CLAUDE_BACKGROUND_MAX_MS;
  }
}, 10_000);

test("sans tâche de fond, le process part après le délai d'inactivité", async () => {
  process.env.PUPITRE_CLAUDE_IDLE_MS = "100";
  try {
    await tour();
    const pid = Number(lignes(pidsFile)[0]);

    await attendre(() => !vivant(pid), 3_000);
    expect(vivant(pid)).toBe(false);
  } finally {
    delete process.env.PUPITRE_CLAUDE_IDLE_MS;
  }
}, 10_000);
