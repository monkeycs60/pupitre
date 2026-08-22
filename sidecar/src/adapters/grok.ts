import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { conductorServerConfig } from "../conductor";
import { pupitreServerConfig } from "../pupitre";
import { parseGrokLine } from "./grok-parser";
import { spawnJsonl } from "./spawn-jsonl";
import type { EmitFn, TurnOptions } from "./types";

export function runGrokTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  const bin = process.env.PUPITRE_GROK_BIN ?? "grok";
  const promptFile = writePromptFile(opts.prompt, opts.images);
  const pluginDir = writeBridgePlugin(opts);
  const permissionMode = opts.permissionMode === "default" ? "default" : opts.permissionMode;
  const args = [
    "--prompt-file", promptFile,
    "--output-format", "streaming-messages-json",
    "--include-partial-messages",
    "--model", opts.model,
    "--permission-mode", permissionMode,
  ];
  if (opts.effort) args.push("--effort", opts.effort);
  if (permissionMode === "bypassPermissions") args.push("--always-approve");
  if (opts.sandboxMode === "read-only") args.push("--sandbox", "read-only");
  if (opts.cliSessionId) args.push("--resume", opts.cliSessionId);
  args.push(
    "--allow", "Edit(~/.claude/**)",
    "--allow", "Edit(~/.codex/**)",
    "--allow", "Edit(~/.grok/**)",
    "--allow", "Write(~/.claude/**)",
    "--allow", "Write(~/.codex/**)",
    "--allow", "Write(~/.grok/**)",
  );
  if (opts.conductor) args.push("--allow", "MCPTool(conductor__*)");
  if (opts.pupitre) args.push("--allow", "MCPTool(pupitre__*)");
  // Review, débrief et sous-tâche n'ont pas le pont Pupitre : one-shot, pas
  // de fork natif. Un fil de conversation le garde — spawn_subagent est une
  // faculté Grok, distincte de Conductor.
  if (!opts.pupitre) args.push("--no-subagents");

  return spawnJsonl({
    bin,
    args,
    cwd: opts.cwd,
    parseLine: parseGrokLine,
    emit,
    signal: opts.signal,
    env: {
      GROK_DISABLE_AUTOUPDATER: "1",
      // Grok n'importe pas les MCP Codex. Sans filtre projet, on reprend ceux
      // de Claude. Un filtre (`mcpServers`) est déjà dans le plugin : on coupe
      // alors le scan pour ne pas relancer toute la liste. Timeout court : un
      // serveur HS bloquait 20 s le premier token.
      GROK_CLAUDE_MCPS_ENABLED: opts.mcpServers ? "false" : "true",
      GROK_CURSOR_MCPS_ENABLED: "false",
      GROK_MCP_STARTUP_TIMEOUT_SECS: "8",
    },
  }).finally(() => {
    rmSync(join(promptFile, ".."), { recursive: true, force: true });
    if (pluginDir) rmSync(pluginDir, { recursive: true, force: true });
  });
}

function writePromptFile(prompt: string, images: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-grok-prompt-"));
  const path = join(dir, "prompt.txt");
  writeFileSync(path, images.length
    ? `${prompt}\n\n[Images jointes: ${images.join(", ")}]`
    : prompt);
  return path;
}

/**
 * `grok -p` n'a pas `--mcp-config` ni `--plugin-dir`. Un plugin user-scoped
 * sous `~/.grok/plugins` est chargé et considéré comme de confiance : on y
 * pose un pont éphémère par tour, conversation-id cuit dans `.mcp.json`.
 */
function writeBridgePlugin(opts: TurnOptions): string | null {
  if (!opts.conductor && !opts.pupitre && !opts.mcpServers) return null;
  const root = process.env.PUPITRE_GROK_PLUGINS_DIR
    ?? join(homedir(), ".grok", "plugins");
  const dir = join(root, `.pupitre-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    name: "pupitre-bridge",
    description: "Pont MCP Pupitre",
  }));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: {
      ...(opts.mcpServers ?? {}),
      ...(opts.conductor ? { conductor: conductorServerConfig(opts.conductor) } : {}),
      ...(opts.pupitre ? { pupitre: pupitreServerConfig(opts.pupitre) } : {}),
    },
  }));
  return dir;
}
