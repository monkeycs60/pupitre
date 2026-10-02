import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ProjectLaunchService, detectLaunchCommands, historyLaunchSuggestions } from "../src/project-launch";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "launch-test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb(root); cleanups.push(() => db.close());
  const projects = new ProjectStore(db); const project = projects.create({ name: "Test", path: root });
  const service = new ProjectLaunchService(db, projects, root); cleanups.push(() => service.close());
  return { root, db, project, service };
}
test("détecte fichiers et compte les conversations distinctes", () => {
  const { root } = fixture();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "bun test" } }));
  writeFileSync(join(root, "bun.lock"), ""); writeFileSync(join(root, "Cargo.toml"), "[package]");
  expect(detectLaunchCommands(root).map((x) => x.command)).toEqual(["bun run dev", "cargo run"]);
  const payload = JSON.stringify({ type: "tool-start", input: { command: "cargo run -p helion-server" } });
  expect(historyLaunchSuggestions([{ conversationId: "a", payload }, { conversationId: "a", payload }, { conversationId: "b", payload }])[0]?.frequency).toBe(2);
});
test("refuse les ports Pupitre et les répertoires qui sortent du projet", async () => {
  const { project, service } = fixture();
  for (const port of [4820, 4821]) expect(() => service.save(project.id, { name: "dev", command: "echo hi", port })).toThrow("réservé");
  const command = service.save(project.id, { name: "dev", command: "echo hi", cwd_relative: ".." });
  await expect(service.launch(command.id)).rejects.toThrow("hors du projet");
});
test("archive les logs et arrête le processus et ses enfants", async () => {
  const { project, service } = fixture();
  const command = service.save(project.id, { name: "dev", command: 'sleep 60 & echo CHILD:$!; wait' });
  const run = await service.launch(command.id);
  expect(run.running).toBe(true);
  const pid = Number(run.logs.match(/CHILD:(\d+)/)?.[1]); expect(pid).toBeGreaterThan(0);
  await service.stop(command.id);
  expect(service.status(command.id).running).toBe(false);
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
  expect(state === "" || state.startsWith("Z")).toBe(true);
});
