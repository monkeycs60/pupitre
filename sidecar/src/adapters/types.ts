import type { AppEvent } from "../events";
import type { MediaAttachment } from "../events";
import type { ConductorTarget } from "../conductor";
import type { PupitreTarget } from "../pupitre";
import type { FilesystemScope } from "../access";

export interface TurnOptions {
  cwd: string;
  model: string;
  effort?: string;
  speed?: string;
  prompt: string;
  cliSessionId: string | null; // null = premier tour
  permissionMode: string;
  filesystemScope?: FilesystemScope;
  /**
   * Racines à ouvrir en plus de `cwd`. Une conversation qui vit dans un
   * worktree a besoin du dépôt principal : son `.git` n'est qu'un fichier
   * « gitdir: … » qui y renvoie, et sans lui plus aucune commande git ne
   * fonctionne depuis le worktree.
   */
  extraWorkspaceRoots?: string[];
  /** Sandbox Codex ; les scans Gardien sont explicitement en lecture seule. */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  images: string[]; // chemins absolus d'images jointes par l'utilisateur
  attachments?: MediaAttachment[];
  signal?: AbortSignal;
  /**
   * Présent uniquement pour les tours d'une conversation ORCHESTRATRICE : le CLI
   * reçoit alors le serveur MCP `conductor` et peut déléguer. Toujours absent
   * pour un tour de sous-tâche (garde de profondeur : un sub-agent ne délègue
   * pas — cf. SubtaskRunner).
   */
  conductor?: ConductorTarget;
  /** Bridge natif toujours attaché aux conversations principales. */
  pupitre?: PupitreTarget;
  /**
   * Définitions des serveurs MCP retenus par le projet. Absent = aucun filtre,
   * le CLI charge ce que l'utilisateur a configuré. Présent (même vide) = seuls
   * ces serveurs sont chargés, bridge conductor compris.
   */
  mcpServers?: Record<string, unknown>;
  /**
   * Noms des serveurs MCP retenus, tous providers confondus. Codex ne prend pas
   * de définitions inline : on lui passe `enabled = false` sur tout ce qui n'est
   * pas dans cette liste. Absent = aucun filtre.
   */
  mcpAllowed?: string[];
}

export type EmitFn = (event: AppEvent) => void;
