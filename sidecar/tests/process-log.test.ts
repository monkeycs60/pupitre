import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProcessLog, processLogPath } from "../src/process-log";

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
