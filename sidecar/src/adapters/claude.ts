import { parseClaudeLine } from "./claude-parser";
import { spawnJsonl } from "./spawn-jsonl";
import type { TurnOptions, EmitFn } from "./types";
import { claudeMcpConfigArg } from "../conductor";
import { aiRoots } from "../access";

export function runClaudeTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  const bin = process.env.PUPITRE_CLAUDE_BIN ?? "claude";
  // M1 : les images utilisateur sont référencées par chemin dans le prompt.
  // (Claude Code lit les fichiers image du disque via son outil Read.)
  const prompt = opts.images.length
    ? `${opts.prompt}\n\n[Images jointes: ${opts.images.join(", ")}]`
    : opts.prompt;
  const permissionMode = opts.permissionMode === "default" ? "auto" : opts.permissionMode;
  const accessDirs = opts.filesystemScope === "full-system" ? ["/"] : aiRoots();
  // `--add-dir` élargit la racine visible, mais ne suffit pas pour les fichiers
  // d'instructions globaux : Claude les traite comme des fichiers sensibles.
  // Ces règles restent bornées aux deux racines IA et ne donnent pas le bypass
  // général réservé au preset YOLO.
  const allowedTools = [
    "Edit(~/.claude/**)",
    "Edit(~/.codex/**)",
    "Write(~/.claude/**)",
    "Write(~/.codex/**)",
    "Bash(npm run build:*)",
    "Bash(bun test:*)",
  ];
  const args = [
    "-p", "--output-format", "stream-json", "--include-partial-messages",
    "--verbose", "--model", opts.model, "--permission-mode", permissionMode,
    // Le cwd reste le projet, mais les instructions globales et la mémoire
    // sont aussi des surfaces de travail légitimes pour Pupitre.
    "--add-dir", ...accessDirs,
  ];
  args.push("--allowedTools", ...allowedTools);
  if (permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  if (opts.effort) args.push("--effort", opts.effort);
  // `--mcp-config` accepte un chemin de fichier OU un JSON inline (cf.
  // `claude --help`). Sans sélection de projet, pas de `--strict-mcp-config` :
  // les serveurs MCP que l'utilisateur a configurés lui-même restent chargés.
  if (opts.conductor || opts.pupitre || opts.mcpServers) {
    args.push(
      "--mcp-config",
      claudeMcpConfigArg(opts.conductor ?? null, opts.mcpServers ?? {}, opts.pupitre ?? null),
    );
  }
  if (opts.mcpServers) {
    // Le projet a choisi ses serveurs : on coupe la découverte automatique pour
    // que seuls ceux-là, plus le bridge, soient chargés.
    args.push("--strict-mcp-config");
  }
  if (opts.conductor) {
    args.push(
      // Un run headless ne peut pas demander une permission MCP à l'UI. On
      // pré-autorise uniquement les trois outils du bridge que Pupitre injecte.
      "--allowedTools",
      "mcp__conductor__delegate,mcp__conductor__delegate_parallel,mcp__conductor__check_quotas",
    );
  }
  if (opts.pupitre) {
    args.push("--allowedTools", "mcp__pupitre__publish_html_document");
  }
  if (opts.cliSessionId) args.push("-r", opts.cliSessionId);
  args.push("--", prompt);

  return spawnJsonl({
    bin,
    args,
    cwd: opts.cwd,
    parseLine: parseClaudeLine,
    emit,
    signal: opts.signal,
  });
}
