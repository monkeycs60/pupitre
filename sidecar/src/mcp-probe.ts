import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Coût d'un serveur MCP dans la fenêtre de contexte.
 *
 * Attention au contre-sens : les CLI récents ne chargent PAS les schémas
 * d'outils au démarrage, ils les diffèrent et ne présentent que les noms. Peser
 * le JSON de `tools/list` surestimait donc le coût d'un facteur ~35. Ce qui est
 * réellement injecté, c'est :
 *   - les `instructions` du serveur, renvoyées par `initialize` ;
 *   - le nom de chaque outil, plus un petit surcoût de présentation.
 *
 * Calibré contre deux mesures CLI réelles : tavily (aucune instruction,
 * 5 outils) coûte 56 tokens ; reddit-mcp-buddy (1 055 caractères
 * d'instructions, 5 outils) en coûte 429.
 *
 * Volontairement à la demande, jamais au démarrage : lancer une quinzaine de
 * process npx coûte plusieurs secondes et de la bande passante.
 */

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

function handshakeTimeoutMs(): number {
  const raw = Number(process.env.PUPITRE_MCP_PROBE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}

/** npx laisse un `sh`/`node` derrière : tuer le pid lancé ne suffit pas. */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Déjà mort.
    }
  }
}

const CHARS_PER_TOKEN = 4;
/** Nom de l'outil mis en forme dans la liste présentée au modèle. */
const TOOL_NAME_TOKENS = 8;
/** En-tête du serveur quand il publie des instructions. */
const SERVER_HEADER_TOKENS = 12;

export interface McpServerWeight {
  name: string;
  /** Tokens estimés des définitions d'outils, ou null si la mesure a échoué. */
  tokens: number | null;
  toolCount: number;
  error?: string;
}

interface ServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

function request(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

/** Poignée de main MCP minimale, puis `tools/list`. */
function probeStdio(name: string, definition: ServerDefinition): Promise<McpServerWeight> {
  return new Promise((resolve) => {
    const command = definition.command;
    if (!command) {
      resolve({ name, tokens: null, toolCount: 0, error: "serveur non stdio" });
      return;
    }
    const child = spawn(command, definition.args ?? [], {
      // On hérite de l'environnement : beaucoup de serveurs ont besoin de PATH,
      // HOME ou d'un token déjà exporté par le shell de l'utilisateur.
      env: { ...process.env, ...(definition.env ?? {}) },
      stdio: ["pipe", "pipe", "ignore"],
      // Groupe dédié : `npx mcp-remote` fork un sh+node qui ignore le SIGKILL
      // du parent. Sans ça, chaque sonde laisse des ClickUp/Mongo orphelins.
      detached: true,
    });

    let settled = false;
    let instructions = "";
    const finish = (result: McpServerWeight) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child);
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ name, tokens: null, toolCount: 0, error: "délai dépassé" }),
      handshakeTimeoutMs(),
    );
    timer.unref();

    child.on("error", (error) => {
      finish({ name, tokens: null, toolCount: 0, error: String(error) });
    });
    child.on("close", () => {
      finish({ name, tokens: null, toolCount: 0, error: "serveur arrêté sans répondre" });
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        // Beaucoup de serveurs écrivent des logs sur stdout : on ignore.
        return;
      }
      if (message.id === 1) {
        // Les instructions du serveur, elles, sont injectées en entier.
        instructions = String(message.result?.instructions ?? "");
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        })}\n`);
        child.stdin.write(request(2, "tools/list", {}));
        return;
      }
      if (message.id === 2) finish(weigh(name, message.result?.tools, instructions));
    });

    child.stdin.on("error", () => {
      finish({ name, tokens: null, toolCount: 0, error: "flux d'entrée fermé" });
    });
    child.stdin.write(request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pupitre", version: "1.0.0" },
    }));
  });
}

/** Exporté pour les tests : la calibration est le cœur de cette mesure. */
export const weighForTest = weigh;

function weigh(name: string, tools: unknown, instructions = ""): McpServerWeight {
  if (!Array.isArray(tools)) {
    return { name, tokens: null, toolCount: 0, error: "réponse tools/list invalide" };
  }
  const names = tools
    .map((tool) => String((tool as { name?: unknown }).name ?? ""))
    .join(" ");
  const tokens = Math.round((instructions.length + names.length) / CHARS_PER_TOKEN)
    + tools.length * TOOL_NAME_TOKENS
    + (instructions ? SERVER_HEADER_TOKENS : 0);
  return { name, tokens, toolCount: tools.length };
}

/**
 * Serveur MCP distant (HTTP streamable). Le protocole est le même qu'en stdio,
 * seul le transport change : deux POST JSON-RPC suffisent pour obtenir la liste
 * d'outils. La réponse peut arriver en JSON simple ou en flux SSE.
 */
async function probeHttp(name: string, url: string): Promise<McpServerWeight> {
  const post = async (body: unknown, sessionId?: string) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(handshakeTimeoutMs()),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    // Un flux SSE préfixe chaque événement par `data: ` ; on ne garde que la
    // dernière charge utile JSON, qui porte la réponse.
    const payload = text.includes("data:")
      ? text.split("\n").filter((line) => line.startsWith("data:")).at(-1)?.slice(5) ?? ""
      : text;
    return {
      sessionId: response.headers.get("mcp-session-id") ?? sessionId,
      message: JSON.parse(payload.trim()),
    };
  };

  try {
    const initialized: any = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pupitre", version: "1.0.0" },
      },
    });
    const listed = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      initialized.sessionId ?? undefined,
    );
    return weigh(
      name,
      listed.message?.result?.tools,
      String(initialized.message?.result?.instructions ?? ""),
    );
  } catch (error) {
    return { name, tokens: null, toolCount: 0, error: String(error) };
  }
}

/**
 * Pèse plusieurs serveurs en parallèle. Un serveur qui échoue n'empêche pas les
 * autres : la mesure est un confort de diagnostic, pas un chemin critique.
 */
let measureQueue: Promise<void> = Promise.resolve();

export async function measureMcpServers(
  definitions: Record<string, unknown>,
): Promise<McpServerWeight[]> {
  // Une sonde à la fois : le GET context-profile relançait la mesure tant
  // qu'un serveur (ClickUp) échouait, et les npx se superposaient.
  const run = measureQueue.then(() => measureMcpServersNow(definitions));
  measureQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function measureMcpServersNow(
  definitions: Record<string, unknown>,
): Promise<McpServerWeight[]> {
  const weights = await Promise.all(
    Object.entries(definitions).map(([name, raw]) => {
      const definition = raw as ServerDefinition;
      return definition.url
        ? probeHttp(name, definition.url)
        : probeStdio(name, definition);
    }),
  );
  return weights.sort((left, right) => (right.tokens ?? -1) - (left.tokens ?? -1));
}
