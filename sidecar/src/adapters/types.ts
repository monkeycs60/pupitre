import type { AppEvent } from "../events";

export interface TurnOptions {
  cwd: string;
  model: string;
  prompt: string;
  cliSessionId: string | null; // null = premier tour
  permissionMode: string;
  images: string[]; // chemins absolus d'images jointes par l'utilisateur
}

export type EmitFn = (event: AppEvent) => void;
