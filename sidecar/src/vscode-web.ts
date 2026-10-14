import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { editorCommand } from "./editor-workspace";
import { killGroup, spawnGroup } from "./process-group";

const READY_TIMEOUT_MS = 120_000;
export const VSCODE_WEB_BASE = "/vscode-web";

export class VscodeWebError extends Error {}

/** Adresse du panneau, relayée par le sidecar sous VSCODE_WEB_BASE. */
export function vscodeWebPath(target: { workspace?: string; folder?: string }): string {
  const query = new URLSearchParams();
  if (target.workspace) query.set("workspace", target.workspace);
  else if (target.folder) query.set("folder", target.folder);
  return `${VSCODE_WEB_BASE}/?${query.toString()}`;
}

async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/**
 * Un seul `code serve-web` pour l'instance, lancé à la première demande :
 * c'est le vrai VS Code, affiché dans Pupitre. Ses extensions et réglages
 * vivent dans `<dataDir>/vscode-web`, à part de ceux du VS Code du bureau.
 */
export class VscodeWebService {
  private server: Promise<{ port: number; token: string; child: ChildProcess }> | null = null;
  private child: ChildProcess | null = null;

  constructor(private readonly dataDir: string) {}

  async url(target: { workspace?: string; folder?: string }): Promise<string> {
    await this.ready();
    return vscodeWebPath(target);
  }

  /** Démarre serve-web au besoin ; le relais du sidecar y ajoute le jeton. */
  async ready(): Promise<{ port: number; token: string }> {
    const { port, token } = await this.ensure();
    return { port, token };
  }

  /** Synchrone : l'arrêt du sidecar enchaîne sur process.exit sans attendre de promesse. */
  stop(): void {
    if (this.child) killGroup(this.child);
    this.child = null;
    this.server = null;
  }

  private ensure() {
    this.server ??= this.start().catch((error) => {
      this.server = null;
      throw error;
    });
    return this.server;
  }

  private async start() {
    const server = await this.serverBinary();
    const port = await freePort();
    const token = randomBytes(24).toString("hex");
    const serverData = join(this.dataDir, "vscode-web");
    mkdirSync(serverData, { recursive: true });
    const child = spawnGroup(server, [
      "--host", "127.0.0.1", "--port", String(port), "--connection-token", token,
      "--accept-server-license-terms", "--telemetry-level", "off", "--server-data-dir", serverData,
      "--server-base-path", VSCODE_WEB_BASE,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    this.child = child;
    if (await this.answers(port, token, child)) return { port, token, child };
    killGroup(child);
    throw new VscodeWebError("le serveur VS Code n'a pas répondu à temps");
  }

  private async answers(port: number, token: string, child: ChildProcess, path = `${VSCODE_WEB_BASE}/`): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < READY_TIMEOUT_MS) {
      if (child.exitCode !== null) throw new VscodeWebError(`le serveur VS Code s'est arrêté (code ${child.exitCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: `vscode-tkn=${token}` }, redirect: "manual" });
        if (response.status === 200 || (response.status >= 300 && response.status < 400)) return true;
      } catch {
        // Pas encore à l'écoute.
      }
      await Bun.sleep(500);
    }
    return false;
  }

  /**
   * Le serveur web de VS Code, lancé sans la CLI : `code serve-web` relaie
   * mal les WebSocket (« upgrade expected but low level API in use ») et
   * l'éditeur ne joignait jamais son serveur. La CLI ne sert qu'à télécharger
   * le serveur la première fois, à la version du VS Code installé.
   */
  private async serverBinary(): Promise<string> {
    const cache = join(homedir(), ".vscode/cli/serve-web");
    const commit = Bun.spawnSync([editorCommand(), "--version"]).stdout.toString().split("\n")[1]?.trim() ?? "";
    const binary = (id: string) => join(cache, id, "bin/code-server");
    if (commit && existsSync(binary(commit))) return binary(commit);
    if (commit) {
      const port = await freePort();
      const token = randomBytes(12).toString("hex");
      const cli = spawnGroup(editorCommand(), [
        "serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token", token,
        "--accept-server-license-terms", "--disable-telemetry", "--commit-id", commit,
      ], { stdio: ["ignore", "ignore", "ignore"] });
      try {
        await this.answers(port, token, cli, "/");
        const started = Date.now();
        while (!existsSync(binary(commit)) && Date.now() - started < READY_TIMEOUT_MS) await Bun.sleep(500);
      } finally {
        killGroup(cli);
      }
      if (existsSync(binary(commit))) return binary(commit);
    }
    const downloaded = existsSync(cache) ? readdirSync(cache).filter((id) => existsSync(binary(id))) : [];
    const newest = downloaded.sort((left, right) => statSync(binary(right)).mtimeMs - statSync(binary(left)).mtimeMs)[0];
    if (!newest) throw new VscodeWebError("serveur VS Code introuvable : le téléchargement par `code serve-web` a échoué");
    return binary(newest);
  }
}
