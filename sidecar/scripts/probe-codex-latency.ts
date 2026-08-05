import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { message?: string };
}

const separator = process.argv.indexOf("--");
const codexArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);
const child = spawn(process.env.PUPITRE_CODEX_BIN ?? "codex", ["app-server", ...codexArgs], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map<number, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>();
const mcp = new Map<string, { startedMs?: number; endedMs?: number; status: string; error?: string }>();
const milestones: Record<string, number> = { spawnedMs: 0 };
let firstItemType: string | null = null;
let stderr = "";

function send(message: RpcMessage): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function request(method: string, params: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message: RpcMessage;
  try {
    message = JSON.parse(line) as RpcMessage;
  } catch {
    return;
  }
  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "erreur JSON-RPC"));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "mcpServer/startupStatus/updated") {
    const name = String(message.params?.name ?? "inconnu");
    const status = String(message.params?.status ?? "inconnu");
    const previous = mcp.get(name) ?? { status };
    if (status === "starting" && previous.startedMs === undefined) previous.startedMs = elapsed();
    if (status !== "starting") previous.endedMs = elapsed();
    previous.status = status;
    if (message.params?.error) previous.error = String(message.params.error).slice(0, 300);
    mcp.set(name, previous);
  }
  if (message.method === "turn/started" && milestones.turnStartedMs === undefined) {
    milestones.turnStartedMs = elapsed();
  }
  if (message.method === "item/started") {
    const type = String(message.params?.item?.type ?? "unknown");
    if (type !== "userMessage" && milestones.firstModelItemMs === undefined) {
      milestones.firstModelItemMs = elapsed();
      firstItemType = type;
    }
  }
  if (
    (message.method === "item/agentMessage/delta" || message.method === "item/completed")
    && milestones.firstContentMs === undefined
  ) {
    const item = message.params?.item;
    const delta = message.params?.delta;
    if (message.method === "item/agentMessage/delta" || item?.type === "agentMessage" || delta?.type === "text") {
      milestones.firstContentMs = elapsed();
    }
  }
  if (message.method === "turn/completed" && milestones.completedMs === undefined) {
    milestones.completedMs = elapsed();
  }
});

child.stderr.on("data", (chunk) => {
  if (stderr.length < 2_000) stderr += String(chunk);
});

const timeout = setTimeout(() => {
  console.error("probe timeout");
  child.kill("SIGTERM");
  process.exitCode = 1;
}, 150_000);

try {
  await request("initialize", {
    clientInfo: { name: "pupitre-latency-probe", title: "Pupitre Latency Probe", version: "0.0.1" },
    capabilities: null,
  });
  milestones.initializedMs = elapsed();
  send({ method: "initialized", params: {} });
  const thread = await request("thread/start", {
    model: "gpt-5.6-luna",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    serviceTier: "fast",
  });
  milestones.threadReadyMs = elapsed();
  const threadId = String(thread?.thread?.id ?? "");
  await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Réponds uniquement : OK." }],
    model: "gpt-5.6-luna",
    effort: "low",
    serviceTier: "fast",
  });
  milestones.turnAcceptedMs = elapsed();
  while (milestones.completedMs === undefined) await Bun.sleep(25);
  console.log(JSON.stringify({
    args: codexArgs,
    milestones,
    firstItemType,
    mcp: Object.fromEntries([...mcp.entries()].sort(([a], [b]) => a.localeCompare(b))),
    stderr: stderr.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(0, 1_000),
  }, null, 2));
} finally {
  clearTimeout(timeout);
  child.kill("SIGTERM");
}
