import type { Provider } from "../events";
import { runClaudeTurn } from "./claude";
import { runCodexTurn } from "./codex";
import { runCodexAppServerTurn } from "./codex-app-server";
import { runGrokTurn } from "./grok";
import type { EmitFn, TurnOptions } from "./types";

/** Point d'entrée unique : un troisième provider ne se câble qu'ici. */
export function runProviderTurn(
  provider: Provider,
  opts: TurnOptions,
  emit: EmitFn,
): Promise<void> {
  if (provider === "claude") return runClaudeTurn(opts, emit);
  if (provider === "grok") return runGrokTurn(opts, emit);
  if (process.env.PUPITRE_CODEX_MODE === "exec") return runCodexTurn(opts, emit);
  return runCodexAppServerTurn(opts, emit);
}
