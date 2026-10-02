import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import {
  PersonalEnvironments,
  incidentFingerprint,
  probeEnvironment,
  sshProbeCommands,
  sshHosts,
} from "../src/personal-environments";
test("sondes SSH simulées, commandes bornées et empreintes normalisées", async () => {
  const seen: string[] = [];
  const result = await probeEnvironment(
    {
      name: "Prod",
      type: "ssh-systemd",
      host: "vps",
      service: "helion",
      directory: "/srv/helion",
    },
    "2026-10-02T10:00:00Z",
    async (_host, command) => {
      seen.push(command);
      return command.startsWith("systemctl")
        ? "active"
        : command.startsWith("git")
          ? "a".repeat(40)
          : "error worker 123";
    },
  );
  expect(result.healthy).toBe(true);
  expect(seen).toHaveLength(3);
  expect(incidentFingerprint("error worker 123")).toBe(
    incidentFingerprint("error worker 456"),
  );
  expect(() =>
    sshProbeCommands(
      { name: "x", type: "ssh-systemd", host: "vps;rm", service: "x" },
      "now",
    ),
  ).toThrow("invalide");
  expect(sshHosts("Host vps\nHost *.test\nHost home other")).toEqual([
    "vps",
    "home",
    "other",
  ]);
});
test("deux erreurs similaires donnent un incident, le triage reste lié au projet", async () => {
  const root = mkdtempSync(join(tmpdir(), "environments-")),
    db = openDb(root);
  try {
    const projects = new ProjectStore(db),
      conversations = new ConversationStore(db);
    const p = projects.create({ name: "Test", path: root });
    const service = new PersonalEnvironments(
      db,
      projects,
      conversations,
      async () => ({
        healthy: true,
        latencyMs: 12,
        errors: ["error worker 123", "error worker 456"],
      }),
    );
    const id = service.save(p.id, {
      name: "Prod",
      type: "http",
      url: "https://example.invalid/health",
    });
    await service.poll(id);
    const env = service.list(p.id)[0]!;
    expect(env.incidents).toHaveLength(1);
    expect(env.incidents[0]).toMatchObject({ count: 2 });
    const incident = env.incidents[0] as { id: string };
    expect(service.triage(incident.id)?.project_id).toBe(p.id);
    expect(service.triage(incident.id)?.id).toBe(
      service.triage(incident.id)?.id,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP et endpoint de version simulés, aucun accès réseau", async () => {
  const urls: string[] = [];
  const result = await probeEnvironment(
    {
      name: "Prod",
      type: "http",
      url: "https://example.invalid/health",
      versionUrl: "https://example.invalid/version",
    },
    "now",
    async () => {
      throw new Error("SSH interdit");
    },
    (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json(
        String(input).endsWith("/version")
          ? { commit: "a".repeat(40) }
          : { ok: true },
      );
    }) as typeof fetch,
  );
  expect(result).toMatchObject({
    healthy: true,
    status: 200,
    commit: "a".repeat(40),
  });
  expect(urls).toHaveLength(2);
});
