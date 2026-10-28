import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const spawnLog = process.env.FAKE_MCP_SPAWN_LOG;
if (spawnLog) appendFileSync(spawnLog, `${process.pid}\n`);

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line) as { id?: number; method?: string; params?: any };
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "1" },
    } });
    return;
  }
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    if (name === "crash") process.exit(3);
    if (name === "slow") await new Promise((resolve) => setTimeout(resolve, args.ms));
    send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: `${args.text ?? ""}|${process.cwd()}|${process.env.FAKE_MCP_TAG ?? ""}` }],
    } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "inconnu" } });
});
