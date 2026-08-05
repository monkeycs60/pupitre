import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_MEMORY_BYTES = 1024 * 1024;

export interface MemoryFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface MemoryDocument extends MemoryFile {
  content: string;
}

export class MemoryStore {
  readonly root: string;

  constructor(root = join(homedir(), ".claude", "memory")) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  list(): MemoryFile[] {
    const files: MemoryFile[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const stats = statSync(absolute);
        files.push({
          path: relative(this.root, absolute).split(sep).join("/"),
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        });
      }
    };
    walk(this.root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  read(path: string): MemoryDocument {
    const absolute = this.existingFile(path);
    const stats = statSync(absolute);
    if (stats.size > MAX_MEMORY_BYTES) throw new Error("fichier mémoire trop volumineux");
    return {
      path,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      content: readFileSync(absolute, "utf8"),
    };
  }

  write(path: string, content: string): MemoryDocument {
    const absolute = this.existingFile(path);
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) {
      throw new Error("fichier mémoire trop volumineux");
    }
    const mode = statSync(absolute).mode;
    const temporary = join(dirname(absolute), `.${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { encoding: "utf8", mode });
      renameSync(temporary, absolute);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
    return this.read(path);
  }

  delete(path: string): void {
    unlinkSync(this.existingFile(path));
  }

  private existingFile(path: string): string {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)) {
      throw new Error("chemin mémoire invalide");
    }
    const absolute = resolve(this.root, path);
    if (!absolute.startsWith(`${this.root}${sep}`)) throw new Error("chemin mémoire invalide");
    const stats = lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("fichier mémoire invalide");
    return absolute;
  }
}
