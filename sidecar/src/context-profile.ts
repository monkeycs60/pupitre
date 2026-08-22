import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Poids sur disque des fichiers d'instructions injectés à chaque session.
 * Mesurable, contrairement au prompt système du CLI : la jauge peut donc les
 * afficher séparément au lieu de tout agréger.
 */

/** Même calibration que la jauge : 3,5 caractères par token sur de la prose. */
const CHARS_PER_TOKEN = 3.5

const GLOBAL_FILES = [
  ".claude/CLAUDE.md",
  ".claude/AGENTS.md",
  ".codex/AGENTS.md",
  ".grok/AGENTS.md",
];

const PROJECT_FILES = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"];

function fileTokens(path: string): number {
  try {
    return Math.round(statSync(path).size / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

/** Fichiers importés par `@nom.md` depuis un fichier d'instructions. */
function importedTokens(path: string, dir: string): number {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const match of content.matchAll(/^@([\w./-]+)\s*$/gmu)) {
    total += fileTokens(join(dir, match[1]!));
  }
  return total;
}

/**
 * Tokens des instructions chargées pour un projet : global et projet réunis.
 * Les imports `@fichier.md` sont suivis sur un niveau, ce qui couvre l'usage
 * courant sans risque de boucle.
 */
export function instructionsTokens(projectPath: string, home = homedir()): number {
  let total = 0;
  for (const relative of GLOBAL_FILES) {
    const path = join(home, relative);
    total += fileTokens(path) + importedTokens(path, join(home, relative, ".."));
  }
  for (const relative of PROJECT_FILES) {
    const path = join(projectPath, relative);
    total += fileTokens(path) + importedTokens(path, projectPath);
  }
  return total;
}
