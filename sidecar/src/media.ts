import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

export function configuredByteLimit(envName: string, fallback: number): number {
  const value = Number(process.env[envName]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export class MediaStore {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "media");
    mkdirSync(this.dir, { recursive: true });
  }
  importFile(absPath: string): string {
    const name = crypto.randomUUID() + (extname(absPath) || ".bin");
    copyFileSync(absPath, join(this.dir, name));
    return name;
  }
  importBytes(bytes: Uint8Array, ext: string): string {
    const name = `${crypto.randomUUID()}.${ext}`;
    writeFileSync(join(this.dir, name), bytes);
    return name;
  }
  byteLength(name: string): number {
    return statSync(this.absolutePath(name)).size;
  }
  absolutePath(name: string): string {
    if (name.includes("/") || name.includes("..")) throw new Error("nom media invalide");
    return join(this.dir, name);
  }
}
