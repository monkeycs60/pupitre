import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Mesure du poids réel d'un serveur MCP : on le lance, on fait la poignée de
 * main MCP, on appelle `tools/list` et on pèse les définitions renvoyées.
 * C'est exactement ce que le CLI injecte dans la fenêtre de contexte.
 *
 * Volontairement à la demande, jamais au démarrage : lancer une quinzaine de
 * process npx coûte plusieurs secondes et de la bande passante.
 */

const HANDSHAKE_TIMEOUT_MS = 20_000;
const CHARS_PER_TOKEN = 4;
/** Surcoût de structure par outil, au-delà du JSON des définitions. */
const TOOL_STRUCTURE_TOKENS = 8;

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
    });

    let settled = false;
    const finish = (result: McpServerWeight) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ name, tokens: null, toolCount: 0, error: "délai dépassé" }),
      HANDSHAKE_TIMEOUT_MS,
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
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        })}\n`);
        child.stdin.write(request(2, "tools/list", {}));
        return;
      }
      if (message.id === 2) {
        const tools = message.result?.tools;
        if (!Array.isArray(tools)) {
          finish({ name, tokens: null, toolCount: 0, error: "réponse tools/list invalide" });
          return;
        }
        const size = JSON.stringify(tools).length;
        finish({
          name,
          tokens: Math.round(size / CHARS_PER_TOKEN) + tools.length * TOOL_STRUCTURE_TOKENS,
          toolCount: tools.length,
        });
      }
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

/**
 * Pèse plusieurs serveurs en parallèle. Un serveur qui échoue n'empêche pas les
 * autres : la mesure est un confort de diagnostic, pas un chemin critique.
 */
export async function measureMcpServers(
  definitions: Record<string, unknown>,
): Promise<McpServerWeight[]> {
  const entries = Object.entries(definitions);
  const weights = await Promise.all(
    entries.map(([name, definition]) => probeStdio(name, definition as ServerDefinition)),
  );
  return weights.sort((left, right) => (right.tokens ?? -1) - (left.tokens ?? -1));
}
