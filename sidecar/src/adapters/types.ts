import type { AppEvent } from "../events";
import type { ConductorTarget } from "../conductor";

export interface TurnOptions {
  cwd: string;
  model: string;
  effort?: string;
  speed?: string;
  prompt: string;
  cliSessionId: string | null; // null = premier tour
  permissionMode: string;
  /** Sandbox Codex ; les scans Gardien sont explicitement en lecture seule. */
  sandboxMode?: "read-only" | "workspace-write";
  images: string[]; // chemins absolus d'images jointes par l'utilisateur
  signal?: AbortSignal;
  /**
   * Présent uniquement pour les tours d'une conversation ORCHESTRATRICE : le CLI
   * reçoit alors le serveur MCP `conductor` et peut déléguer. Toujours absent
   * pour un tour de sous-tâche (garde de profondeur : un sub-agent ne délègue
   * pas — cf. SubtaskRunner).
   */
  conductor?: ConductorTarget;
}

export type EmitFn = (event: AppEvent) => void;
