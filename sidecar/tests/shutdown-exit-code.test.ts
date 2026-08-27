import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Le contrat d'arrêt du sidecar est réparti entre deux langages : le code de
 * sortie est choisi en TypeScript, interprété en Rust. Rien ne les relie, et
 * les désaccorder laisse l'app sans backend — ce qui est arrivé.
 */

const root = join(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

test("un signal externe ne sort pas 0, sinon le superviseur ne relance pas", () => {
  const source = read("sidecar/src/index.ts");

  // Les deux signaux passent par la branche « subie », pas par « requested ».
  expect(source).toContain('process.on("SIGTERM", () => shutdownGracefully("signal"))');
  expect(source).toContain('process.on("SIGINT", () => shutdownGracefully("signal"))');
  // Seule l'éviction demandée par une instance plus récente sort 0.
  expect(source).toContain('shutdown: () => shutdownGracefully("requested")');
  expect(source).toMatch(/cause === "requested" \? 0 : KILLED_EXIT_CODE/);
  expect(source).toMatch(/const KILLED_EXIT_CODE = 143/);
});

test("le superviseur Tauri ne considère volontaire que le code 0", () => {
  const supervisor = read("src-tauri/src/lib.rs");

  expect(supervisor).toContain("if payload.code == Some(0)");
  expect(supervisor).toContain("intentional_exit = true");
});

test("l'arrêt annule les tours en vol avant de sortir", () => {
  const source = read("sidecar/src/index.ts");

  // Les serveurs MCP d'un tour vivent dans le groupe du provider : sortir sans
  // avoir signalé ce groupe les laisse orphelins, et ils s'accumulent.
  const abort = source.indexOf("runner.abortAll()");
  const exit = source.indexOf('process.exit(cause === "requested"');
  expect(abort).toBeGreaterThan(-1);
  expect(exit).toBeGreaterThan(abort);
});
