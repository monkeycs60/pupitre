import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnJsonl } from "../src/adapters/spawn-jsonl";
import type { AppEvent } from "../src/events";

test("ignore une erreur de parsing et continue le flux JSONL", async () => {
  const events: AppEvent[] = [];
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);

  try {
    await spawnJsonl({
      bin: "/bin/sh",
      args: ["-c", "printf 'invalide\\nvalide\\n'"],
      cwd: "/tmp",
      parseLine: (line) => {
        if (line === "invalide") throw new Error("ligne invalide");
        return [{ type: "text-final", text: line }];
      },
      emit: (event) => events.push(event),
    });
  } finally {
    console.error = originalConsoleError;
  }

  expect(errors).toHaveLength(1);
  expect(events).toEqual([
    { type: "status", state: "running" },
    { type: "text-final", text: "valide" },
    { type: "status", state: "done" },
  ]);
});

test("AbortSignal tue le child et émet status error annulé", async () => {
  const events: AppEvent[] = [];
  const controller = new AbortController();
  const turn = spawnJsonl({
    bin: "/bin/sh",
    args: ["-c", "exec sleep 30"],
    cwd: "/tmp",
    parseLine: () => [],
    emit: (event) => events.push(event),
    signal: controller.signal,
  });

  controller.abort();
  await turn;

  expect(events).toEqual([
    { type: "status", state: "running" },
    { type: "status", state: "error", error: "annulé" },
  ]);
});

test("AbortSignal escalade en SIGKILL si le child ignore SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-stubborn-child-"));
  const stubbornBin = join(dir, "stubborn-child");
  writeFileSync(stubbornBin, `#!/bin/sh
trap '' TERM
printf 'READY\\n'
exec sleep 30
`);
  chmodSync(stubbornBin, 0o755);

  const events: AppEvent[] = [];
  const controller = new AbortController();
  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const turn = spawnJsonl({
    bin: stubbornBin,
    args: [],
    cwd: dir,
    parseLine: (line) => {
      if (line === "READY") signalReady();
      return [];
    },
    emit: (event) => events.push(event),
    signal: controller.signal,
  });

  await ready;
  const abortedAt = performance.now();
  controller.abort();
  await turn;

  expect(performance.now() - abortedAt).toBeGreaterThanOrEqual(2_900);
  expect(events).toEqual([
    { type: "status", state: "running" },
    { type: "status", state: "error", error: "annulé" },
  ]);
}, 7_000);

/** `kill(pid, 0)` reste vrai sur un zombie : laisser le temps au reaping. */
async function attendreLaMort(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const limite = performance.now() + timeoutMs;
  while (performance.now() < limite) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("l'abort tue les petits-enfants du provider, pas seulement le provider", async () => {
  const events: AppEvent[] = [];
  const controller = new AbortController();
  let petitFils = 0;
  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });

  const turn = spawnJsonl({
    bin: "/bin/sh",
    // `sleep` tient le rôle d'un serveur MCP : enfant du provider, donc hors de
    // portée d'un signal visant le seul pid du provider.
    args: ["-c", 'sleep 30 & printf "PID=%s\\n" "$!"; wait'],
    cwd: "/tmp",
    parseLine: (line) => {
      const match = line.match(/^PID=(\d+)$/);
      if (match) {
        petitFils = Number(match[1]);
        signalReady();
      }
      return [];
    },
    emit: (event) => events.push(event),
    signal: controller.signal,
  });

  await ready;
  expect(petitFils).toBeGreaterThan(0);
  expect(() => process.kill(petitFils, 0)).not.toThrow();

  controller.abort();
  await turn;

  expect(await attendreLaMort(petitFils)).toBe(true);
}, 10_000);
