import { parseClaudeLine } from "./claude-parser";
import { claudeSessions, persistenceEnabled } from "./claude-session";
import { spawnJsonl } from "./spawn-jsonl";
import type { TurnOptions, EmitFn } from "./types";
import { claudeMcpConfigArg } from "../pupitre";
import { aiRoots } from "../access";

const CLAUDE_MODEL_IDS: Record<string, string> = {
  "fable-5.1": "claude-fable-5-1",
  "fable-5": "claude-fable-5",
};

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
  const permissionMode = opts.permissionMode;
  const model = CLAUDE_MODEL_IDS[opts.model] ?? opts.model;
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
  if (opts.pupitre || opts.mcpServers) {
    args.push(
      "--mcp-config",
      claudeMcpConfigArg(opts.mcpServers ?? {}, opts.pupitre ?? null),
    );
  }
  if (opts.mcpServers) {
    // Le projet a choisi ses serveurs : on coupe la découverte automatique pour
    // que seuls ceux-là soient chargés.
    args.push("--strict-mcp-config");
  }
  if (opts.pupitre) {
    args.push(
      "--allowedTools",
      "mcp__pupitre__publish_document,mcp__pupitre__publish_html_document,mcp__pupitre__read_sibling_conversation",
    );
  }
  const line = (prompt: string, images: string[]) =>
    JSON.stringify(userMessage(prompt, images));

  if (persistenceEnabled()) {
    // `-r` reste hors des args : il ne sert qu'au démarrage d'un process neuf,
    // et le pool le rajoute lui-même quand il en ouvre un.
    return claudeSessions.runTurn({
      bin,
      args,
      cwd: opts.cwd,
      cliSessionId: opts.cliSessionId,
      line: line(opts.prompt, opts.images),
      steerLine: line,
      emit,
      signal: opts.signal,
      registerSteer: opts.registerSteer,
    });
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
      initialLine: line(opts.prompt, opts.images),
      registerWrite: (writeLine) => opts.registerSteer?.(async (input) => writeLine(
        line(input.prompt, input.images),
      )),
    },
  });
}
