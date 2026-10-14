import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProcessLog, processLogPath, readLifecycle } from "../src/process-log";

function fakeConsole() {
  const printed: string[] = [];
  const record = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  return { printed, target: { log: record, info: record, warn: record, error: record } };
}

test("ajoute chaque ligne de la console au journal sans effacer les précédentes", () => {
  const path = processLogPath(mkdtempSync(join(tmpdir(), "pupitre-log-")));
  writeFileSync(path, "trace de l'arrêt précédent\n");
  const { printed, target } = fakeConsole();
  installProcessLog(path, target, { now: () => new Date("2026-10-14T21:00:00.000Z"), pid: 42 });

  target.log("prêt sur", 4821);
  target.error("arrêt du sidecar : SIGTERM");

  expect(printed).toEqual(["prêt sur 4821", "arrêt du sidecar : SIGTERM"]);
  expect(readFileSync(path, "utf8")).toBe([
    "trace de l'arrêt précédent",
    "[2026-10-14T21:00:00.000Z] démarrage du sidecar (pid 42)",
    "[2026-10-14T21:00:00.000Z] prêt sur 4821",
    "[2026-10-14T21:00:00.000Z] ERROR arrêt du sidecar : SIGTERM",
    "",
  ].join("\n"));
});

test("un journal trop gros est mis de côté au démarrage", () => {
  const path = processLogPath(mkdtempSync(join(tmpdir(), "pupitre-log-")));
  writeFileSync(path, "x".repeat(100));
  installProcessLog(path, fakeConsole().target, { maxBytes: 50 });

  expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(100));
  expect(readFileSync(path, "utf8")).toContain("démarrage du sidecar");
});

test("un journal impossible à écrire ne casse pas la console", () => {
  const { printed, target } = fakeConsole();
  installProcessLog(join(tmpdir(), "dossier-absent", "sous", "sidecar.log"), target);
  target.error("toujours affiché");
  expect(printed).toEqual(["toujours affiché"]);
  expect(existsSync(join(tmpdir(), "dossier-absent"))).toBe(false);
});

test("relit démarrages, arrêts, erreurs et morts sans trace, du plus récent au plus ancien", () => {
  const path = processLogPath(mkdtempSync(join(tmpdir(), "pupitre-log-")));
  writeFileSync(path, [
    "[2026-10-14T20:00:00.000Z] démarrage du sidecar (pid 1)",
    "[2026-10-14T20:00:01.000Z] pupitre sidecar prêt sur http://localhost:4821",
    "[2026-10-14T20:10:00.000Z] ERROR promesse rejetée sans gestionnaire, le sidecar continue : Error: boum",
    "    at quelque part",
    "[2026-10-14T20:20:00.000Z] démarrage du sidecar (pid 2)",
    "[2026-10-14T20:20:01.000Z] pupitre sidecar prêt sur http://localhost:4821",
    "[2026-10-14T20:30:00.000Z] démarrage du sidecar (pid 3)",
    "[2026-10-14T20:30:02.000Z] ERROR [2026-10-14T20:30:02.000Z] arrêt du sidecar : éviction par une autre instance (POST /api/shutdown)",
    "[2026-10-14T20:30:03.000Z] pupitre sidecar prêt sur http://localhost:4821",
    "",
  ].join("\n"));

  expect(readLifecycle(path)).toEqual([
    { at: "2026-10-14T20:30:03.000Z", kind: "start", detail: "pid 3" },
    { at: "2026-10-14T20:30:02.000Z", kind: "stop", detail: "éviction par une autre instance (POST /api/shutdown)" },
    { at: "2026-10-14T20:20:01.000Z", kind: "start", detail: "pid 2" },
    { at: "2026-10-14T20:20:01.000Z", kind: "unexplained", detail: "arrêt sans trace avant ce démarrage" },
    { at: "2026-10-14T20:10:00.000Z", kind: "rejection", detail: "Error: boum" },
    { at: "2026-10-14T20:00:01.000Z", kind: "start", detail: "pid 1" },
  ]);
  expect(readLifecycle(path, 2)).toHaveLength(2);
  expect(readLifecycle(join(tmpdir(), "journal-absent.log"))).toEqual([]);
});
