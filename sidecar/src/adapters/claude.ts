import { parseClaudeLine } from "./claude-parser";
import { spawnJsonl } from "./spawn-jsonl";
import type { TurnOptions, EmitFn } from "./types";
import { claudeMcpConfigArg } from "../conductor";
import { aiRoots } from "../access";

export function runClaudeTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  const bin = process.env.PUPITRE_CLAUDE_BIN ?? "claude";
  const userMessage = (prompt: string, images: string[]) => ({
    type: "user",
    message: {
      role: "user",
      // Le protocole stream-json de Claude Code est textuel. Les images sont
      // donc référencées par chemin et Claude les lit avec son outil Read.
      content: [{
        type: "text",
        text: images.length
          ? `${prompt}\n\n[Images jointes: ${images.join(", ")}]`
          : prompt,
      }],
    },
  });
  const permissionMode = opts.permissionMode === "default" ? "auto" : opts.permissionMode;
  const model = opts.model === "fable-5" ? "fable" : opts.model;
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
    "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose", "--model", model, "--permission-mode", permissionMode,
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
    args.push(
      "--allowedTools",
      "mcp__pupitre__publish_document,mcp__pupitre__publish_html_document,mcp__pupitre__read_sibling_conversation",
    );
  }
  if (opts.cliSessionId) args.push("-r", opts.cliSessionId);

  return spawnJsonl({
    bin,
    args,
    cwd: opts.cwd,
    parseLine: parseClaudeLine,
    emit,
    signal: opts.signal,
    streamingInput: {
      initialLine: JSON.stringify(userMessage(opts.prompt, opts.images)),
      registerWrite: (writeLine) => opts.registerSteer?.(async (input) => writeLine(
        JSON.stringify(userMessage(input.prompt, input.images)),
      )),
    },
  });
}
