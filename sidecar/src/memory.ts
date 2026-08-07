import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_MEMORY_BYTES = 1024 * 1024;

export class MemoryPathError extends Error {}

export class MemoryFileNotFoundError extends Error {}

export class MemoryFileExistsError extends Error {}

export class MemoryFileTooLargeError extends Error {}

export interface MemoryFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface MemoryDocument extends MemoryFile {
  content: string;
}

type PathMode = "existing" | "new";

export class MemoryStore {
  readonly root: string;

  constructor(root = join(homedir(), ".claude", "memory")) {
    const resolvedRoot = resolve(root);
    mkdirSync(resolvedRoot, { recursive: true });
    const rootStats = lstatSync(resolvedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new MemoryPathError("racine mémoire invalide");
    }
    this.root = resolvedRoot;
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
    const bytes = readFileSync(absolute);
    if (bytes.byteLength > MAX_MEMORY_BYTES) throw new MemoryFileTooLargeError("fichier mémoire trop volumineux");
    const stats = statSync(absolute);
    return {
      path,
      size: bytes.byteLength,
      modifiedAt: stats.mtime.toISOString(),
      content: bytes.toString("utf8"),
    };
  }

  create(path: string, content = ""): MemoryDocument {
    this.markdownPath(path);
    this.assertSize(content);
    const absolute = this.validatedPath(path, "new");
    const descriptor = openSync(absolute, "wx", 0o600);
    try {
      writeFileSync(descriptor, Buffer.from(content, "utf8"));
    } catch (error) {
      try { unlinkSync(absolute); } catch {}
      throw error;
    } finally {
      closeSync(descriptor);
    }
    return this.read(path);
  }

  write(path: string, content: string): MemoryDocument {
    this.assertSize(content);
    const absolute = this.existingFile(path);
    const mode = statSync(absolute).mode & 0o7777;
    const temporary = join(dirname(absolute), `.${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode });
      renameSync(temporary, absolute);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
    return this.read(path);
  }

  rename(path: string, newPath: string): MemoryDocument {
    this.markdownPath(newPath);
    const source = this.existingFile(path);
    const destination = this.validatedPath(newPath, "new");
    if (source === destination) throw new MemoryFileExistsError("le fichier porte déjà ce nom");
    renameSync(source, destination);
    return this.read(newPath);
  }

  delete(path: string): void {
    unlinkSync(this.existingFile(path));
  }

  private assertSize(content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) {
      throw new MemoryFileTooLargeError("fichier mémoire trop volumineux");
    }
  }

  private markdownPath(path: string): void {
    this.validateRelativePath(path);
    if (extname(path).toLowerCase() !== ".md") {
      throw new MemoryPathError("un fichier mémoire doit être au format Markdown (.md)");
    }
  }

  private existingFile(path: string): string {
    return this.validatedPath(path, "existing");
  }

  private validatedPath(path: string, mode: PathMode): string {
    const parts = this.validateRelativePath(path);
    const absolute = join(this.root, ...parts);
    if (!absolute.startsWith(`${this.root}${sep}`)) {
      throw new MemoryPathError("chemin mémoire invalide");
    }

    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(current);
      } catch (error) {
        if (mode === "new" && index === parts.length - 1 && isNotFound(error)) return absolute;
        throw new MemoryFileNotFoundError("fichier mémoire inconnu");
      }
      if (stats.isSymbolicLink()) throw new MemoryPathError("les symlinks sont interdits dans la mémoire");
      if (index < parts.length - 1) {
        if (!stats.isDirectory()) throw new MemoryPathError("chemin mémoire invalide");
        continue;
      }
      if (mode === "new") {
        throw new MemoryFileExistsError("un fichier mémoire porte déjà ce nom");
      }
      if (!stats.isFile()) throw new MemoryFileNotFoundError("fichier mémoire inconnu");
    }
    return absolute;
  }

  private validateRelativePath(path: string): string[] {
    if (
      typeof path !== "string"
      || !path
      || isAbsolute(path)
      || path.includes("\0")
    ) {
      throw new MemoryPathError("chemin mémoire invalide");
    }
    const parts = path.split(/[\\/]/);
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new MemoryPathError("chemin mémoire invalide");
    }
    return parts;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
