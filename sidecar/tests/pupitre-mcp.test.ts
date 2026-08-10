import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pupitreMcpPath, pupitreServerConfig } from "../src/pupitre";

const clients: Client[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop(true);
});

test("le bridge compilé et le bridge de développement pointent vers le bon processus", () => {
  expect(pupitreServerConfig(
    { port: 4820, conversationId: "conversation-1" },
    "/usr/bin/pupitre-sidecar",
  )).toEqual({
    command: "/usr/bin/pupitre-sidecar",
    args: ["--pupitre-mcp"],
    env: {
      PUPITRE_PORT: "4820",
      PUPITRE_CONVERSATION_ID: "conversation-1",
    },
  });
  expect(pupitreServerConfig(
    { port: 4820, conversationId: "conversation-1" },
    "/home/clement/.bun/bin/bun",
  ).args).toEqual([pupitreMcpPath()]);
});

test("publish_html_document transmet un document au sidecar local", async () => {
  let received: unknown = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received = await request.json();
      return Response.json({
        id: "document-1",
        title: "Audit",
        expiresAt: "2026-08-11T10:00:00.000Z",
      }, { status: 201 });
    },
  });
  servers.push(server);
  const client = new Client({ name: "test-pupitre", version: "0.0.0" });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [pupitreMcpPath()],
    env: {
      PATH: process.env.PATH ?? "",
      PUPITRE_PORT: String(server.port),
      PUPITRE_CONVERSATION_ID: "conversation-1",
    },
  }));

  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["publish_document", "publish_html_document"]);
  expect(tools[0]?.description).toContain("jusqu’à suppression explicite");

  const result = await client.callTool({
    name: "publish_html_document",
    arguments: {
      path: "/tmp/audit.html",
      title: "Audit",
      summary: "Synthèse",
      delete_source: true,
    },
  }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

  expect(result.isError).toBeFalsy();
  expect(result.content[0]?.text).toContain("Document HTML publié");
  expect(received).toEqual({
    path: "/tmp/audit.html",
    title: "Audit",
    summary: "Synthèse",
    deleteSource: true,
  });
});
