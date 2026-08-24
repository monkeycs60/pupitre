// Faux `codex app-server` : parle le protocole JSON-RPC newline-delimited et
// rejoue les notifications de tests/fixtures/codex-app-server-basic.jsonl.
//
// Variables d'environnement (toutes optionnelles) :
// - FAKE_APP_SERVER_LOG        : fichier où logger chaque message reçu (une ligne JSON)
// - FAKE_APP_SERVER_PID        : fichier où écrire le pid (test de restart)
// - FAKE_APP_SERVER_ARGS       : fichier où écrire les arguments du process
// - FAKE_APP_SERVER_HANG=1     : le tour ne se termine jamais tout seul (test d'annulation)
// - FAKE_APP_SERVER_SILENT=m,m : méthodes auxquelles ne jamais répondre (test de timeout)
// - FAKE_APP_SERVER_SLOW_MS=n  : délai avant la réponse à thread/start (test d'annulation au setup)
// - FAKE_APP_SERVER_SLOW_TURN_MS=n : délai avant la réponse à turn/start
// - FAKE_APP_SERVER_INIT_ERROR=1 : `initialize` répond une erreur JSON-RPC, process vivant
// - FAKE_APP_SERVER_REJECT_CAPABILITIES=1 : simule un app-server ancien qui
//   rejette `initialize` dès que `capabilities` est présent
// - FAKE_APP_SERVER_CHILD_PID   : fichier où écrire le pid d'un enfant longue durée
//   (simule un serveur MCP npx : il doit mourir avec l'app-server)
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

const FIXTURE = join(dirname(import.meta.dir), "fixtures/codex-app-server-basic.jsonl");

if (process.argv[2] !== "app-server") {
  console.error(`fake-codex-app-server: sous-commande inattendue ${process.argv[2]}`);
  process.exit(2);
}
if (process.env.FAKE_APP_SERVER_PID) {
  writeFileSync(process.env.FAKE_APP_SERVER_PID, String(process.pid));
}
if (process.env.FAKE_APP_SERVER_ARGS) {
  writeFileSync(process.env.FAKE_APP_SERVER_ARGS, JSON.stringify(process.argv.slice(2)));
}
if (process.env.FAKE_APP_SERVER_CHILD_PID) {
  // Comme un vrai serveur MCP stdio : il hérite du groupe de process et ne se
  // termine pas de lui-même.
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_APP_SERVER_CHILD_PID, String(child.pid));
}

const silent = new Set((process.env.FAKE_APP_SERVER_SILENT ?? "").split(",").filter(Boolean));
const slowMs = Number(process.env.FAKE_APP_SERVER_SLOW_MS ?? 0);
const slowTurnMs = Number(process.env.FAKE_APP_SERVER_SLOW_TURN_MS ?? 0);

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

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

// Chaque thread/start rend un id distinct : c'est ce qui permet de tester le
// multiplexage (deux conversations en parallèle sur le même process).
let threadCounter = 0;
let turnCounter = 0;
let steerRejected = false;

function retarget(
  params: Record<string, unknown>,
  threadId: string,
  turnId: string,
): Record<string, unknown> {
  const rewritten: Record<string, unknown> = { ...params };
  if ("threadId" in rewritten) rewritten.threadId = threadId;
  if ("turnId" in rewritten) rewritten.turnId = turnId;
  if (rewritten.turn && typeof rewritten.turn === "object") {
    rewritten.turn = { ...(rewritten.turn as object), id: turnId };
  }
  return rewritten;
}

// Rejoué de façon asynchrone : deux tours concurrents s'entrelacent réellement,
// ce qui est le point du test de multiplexage.
async function replayTurn(threadId: string, turnId: string): Promise<void> {
  for (const notification of turnNotifications) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const isCompleted = notification.method === "turn/completed";
    if (isCompleted && process.env.FAKE_APP_SERVER_HANG === "1") return;
    send({
      jsonrpc: "2.0",
      method: notification.method,
      params: retarget(notification.params, threadId, turnId),
    });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  if (process.env.FAKE_APP_SERVER_LOG) appendFileSync(process.env.FAKE_APP_SERVER_LOG, line + "\n");
  const message = JSON.parse(line) as { id?: number; method?: string; params?: any };
  const { id, method, params } = message;
  if (id === undefined) return; // notification cliente (`initialized`) : rien à faire
  if (method && silent.has(method)) return; // jamais de réponse : déclenche le timeout client

  switch (method) {
    case "initialize":
      if (process.env.FAKE_APP_SERVER_INIT_ERROR === "1") {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: "handshake refusé" } });
        return;
      }
      if (
        process.env.FAKE_APP_SERVER_REJECT_CAPABILITIES === "1" &&
        params?.capabilities !== undefined
      ) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown field `capabilities`" } });
        return;
      }
      send({ jsonrpc: "2.0", id, result: { userAgent: "fake-codex-app-server/0.0.0" } });
      return;
    case "thread/start": {
      const threadId = `fake-thread-${pad(++threadCounter)}`;
      const reply = () => {
        send({ jsonrpc: "2.0", id, result: { thread: { id: threadId }, model: params?.model } });
        send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId } } });
      };
      if (slowMs > 0) setTimeout(reply, slowMs);
      else reply();
      return;
    }
    case "thread/resume": {
      const threadId = params?.threadId ?? `fake-thread-${pad(++threadCounter)}`;
      send({ jsonrpc: "2.0", id, result: { thread: { id: threadId } } });
      return;
    }
    case "turn/start": {
      const threadId = String(params?.threadId ?? "");
      const turnId = `fake-turn-${pad(++turnCounter)}`;
      const reply = () => {
        send({ jsonrpc: "2.0", id, result: { turn: { id: turnId, status: "inProgress" } } });
        void replayTurn(threadId, turnId);
      };
      if (slowTurnMs > 0) setTimeout(reply, slowTurnMs);
      else reply();
      return;
    }
    case "turn/interrupt":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "turn/steer":
      if (process.env.FAKE_APP_SERVER_REJECT_FIRST_STEER === "1" && !steerRejected) {
        steerRejected = true;
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: "tour pas encore actif" } });
        return;
      }
      send({ jsonrpc: "2.0", id, result: { turnId: params?.expectedTurnId } });
      return;
    case "account/rateLimits/read":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          rateLimits: {
            primary: {
              usedPercent: 42,
              resetsAt: 1_800_000_000,
              windowDurationMins: 300,
            },
          },
        },
      });
      return;
    default:
      send({ jsonrpc: "2.0", id, result: {} });
  }
});
