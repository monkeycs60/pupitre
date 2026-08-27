import { killGroup, spawnGroup } from "./process-group";

/**
 * Vérification par la mesure, plutôt que par l'estimation.
 *
 * La sonde `mcp-probe` pèse les définitions d'outils et en déduit un coût. Ici
 * on demande au CLI lui-même : deux tours minimaux, l'un avec les serveurs
 * retenus, l'autre sans aucun, et on lit le contexte qu'il rapporte. L'écart
 * est le coût réel de la sélection — serveurs non mesurables compris.
 */

const PROBE_PROMPT = "ok";
const PROBE_TIMEOUT_MS = 120_000;

export interface ContextProbe {
  /** Contexte rapporté avec la sélection du projet chargée. */
  withServers: number;
  /** Contexte rapporté sans aucun serveur MCP. */
  without: number;
  /** Coût réel de la sélection : la différence des deux. */
  cost: number;
  error?: string;
}

/** Un tour minimal, avec la configuration MCP donnée. */
function probeTurn(cwd: string, model: string, mcpConfig: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const bin = process.env.PUPITRE_CLAUDE_BIN ?? "claude";
    const args = ["-p", "--output-format", "json", "--model", model];
    if (mcpConfig !== null) args.push("--strict-mcp-config", "--mcp-config", mcpConfig);
    args.push("--", PROBE_PROMPT);

    const child = spawnGroup(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.slice(-300) || `exit ${code}`));
        return;
      }
      try {
        const usage = (JSON.parse(stdout) as { usage?: Record<string, number> }).usage ?? {};
        // Le contexte d'entrée se répartit entre lecture de cache, création de
        // cache et tokens neufs : c'est leur somme qui occupe la fenêtre.
        resolve(
          (usage.input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0),
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/**
 * Coût réel de la sélection MCP d'un projet. Deux tours séquentiels et non
 * parallèles : deux CLI simultanés fausseraient la mesure en se partageant le
 * cache de prompt.
 */
export async function verifyMcpContextCost(
  cwd: string,
  selected: Record<string, unknown>,
  model = "claude-haiku-4-5-20251001",
): Promise<ContextProbe> {
  try {
    const without = await probeTurn(cwd, model, JSON.stringify({ mcpServers: {} }));
    const withServers = await probeTurn(
      cwd,
      model,
      JSON.stringify({ mcpServers: selected }),
    );
    return { withServers, without, cost: withServers - without };
  } catch (error) {
    return { withServers: 0, without: 0, cost: 0, error: String(error) };
  }
}
