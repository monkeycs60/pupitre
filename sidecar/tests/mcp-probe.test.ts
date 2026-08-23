import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureMcpServers } from "../src/mcp-probe";

const HANG = join(import.meta.dir, "fake-bins/fake-mcp-hang");

afterEach(() => {
  delete process.env.PUPITRE_MCP_PROBE_TIMEOUT_MS;
  delete process.env.FAKE_MCP_CHILD_PID;
});

function childStillAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("la sonde tue le petit-enfant npx, pas seulement le process lancé", async () => {
  chmodSync(HANG, 0o755);
  const dir = mkdtempSync(join(tmpdir(), "pupitre-mcp-probe-"));
  const childPidFile = join(dir, "child-pid");
  process.env.PUPITRE_MCP_PROBE_TIMEOUT_MS = "400";
  process.env.FAKE_MCP_CHILD_PID = childPidFile;

  const weights = await measureMcpServers({
    hang: { command: HANG, args: [] },
  });
  expect(weights[0]?.tokens).toBeNull();

  const childPid = Number(readFileSync(childPidFile, "utf8"));
  expect(childPid).toBeGreaterThan(0);
  // Sans kill du groupe, `sleep` survit orphelin — le bloat ClickUp/Mongo.
  await Bun.sleep(80);
  expect(childStillAlive(childPid)).toBe(false);
});
