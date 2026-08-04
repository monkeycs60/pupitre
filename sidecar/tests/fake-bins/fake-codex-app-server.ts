// Faux `codex app-server` : parle le protocole JSON-RPC newline-delimited et
// rejoue les notifications de tests/fixtures/codex-app-server-basic.jsonl.
//
// Variables d'environnement (toutes optionnelles) :
// - FAKE_APP_SERVER_LOG    : fichier où logger chaque message reçu (une ligne JSON)
// - FAKE_APP_SERVER_PID    : fichier où écrire le pid (test de restart)
// - FAKE_APP_SERVER_HANG=1 : le tour ne se termine jamais tout seul (test d'annulation)
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

const FIXTURE = join(dirname(import.meta.dir), "fixtures/codex-app-server-basic.jsonl");
const THREAD_ID = "fake-thread-0001";
const TURN_ID = "fake-turn-0001";

if (process.argv[2] !== "app-server") {
  console.error(`fake-codex-app-server: sous-commande inattendue ${process.argv[2]}`);
  process.exit(2);
}
if (process.env.FAKE_APP_SERVER_PID) {
  writeFileSync(process.env.FAKE_APP_SERVER_PID, String(process.pid));
}

// Notifications du tour : tout ce qui suit `turn/start` dans la fixture réelle.
const turnNotifications = (() => {
  const lines = readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = lines.findIndex((l) => l.dir === "out" && l.msg?.method === "turn/start");
  return lines
    .slice(start)
    .filter((l) => l.dir === "in" && typeof l.msg?.method === "string" && l.msg.id === undefined)
    .map((l) => l.msg as { method: string; params: Record<string, unknown> })
    .filter((m) => m.method !== "mcpServer/startupStatus/updated");
})();

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

let currentThreadId = THREAD_ID;

function retarget(params: Record<string, unknown>): Record<string, unknown> {
  const rewritten: Record<string, unknown> = { ...params };
  if ("threadId" in rewritten) rewritten.threadId = currentThreadId;
  if ("turnId" in rewritten) rewritten.turnId = TURN_ID;
  if (rewritten.turn && typeof rewritten.turn === "object") {
    rewritten.turn = { ...(rewritten.turn as object), id: TURN_ID };
  }
  return rewritten;
}

function replayTurn(): void {
  for (const notification of turnNotifications) {
    const isCompleted = notification.method === "turn/completed";
    if (isCompleted && process.env.FAKE_APP_SERVER_HANG === "1") return;
    send({ jsonrpc: "2.0", method: notification.method, params: retarget(notification.params) });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  if (process.env.FAKE_APP_SERVER_LOG) appendFileSync(process.env.FAKE_APP_SERVER_LOG, line + "\n");
  const message = JSON.parse(line) as { id?: number; method?: string; params?: any };
  const { id, method, params } = message;
  if (id === undefined) return; // notification cliente (`initialized`) : rien à faire

  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: { userAgent: "fake-codex-app-server/0.0.0" } });
      return;
    case "thread/start":
      currentThreadId = THREAD_ID;
      send({ jsonrpc: "2.0", id, result: { thread: { id: THREAD_ID }, model: params?.model } });
      send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: THREAD_ID } } });
      return;
    case "thread/resume":
      currentThreadId = params?.threadId ?? THREAD_ID;
      send({ jsonrpc: "2.0", id, result: { thread: { id: currentThreadId } } });
      return;
    case "turn/start":
      send({ jsonrpc: "2.0", id, result: { turn: { id: TURN_ID, status: "inProgress" } } });
      replayTurn();
      return;
    case "turn/interrupt":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    default:
      send({ jsonrpc: "2.0", id, result: {} });
  }
});
