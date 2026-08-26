import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import type { MediaStore } from "./media";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const MARKDOWN_IMAGE = /(!\[[^\]]*\]\()<?(\/[^)>\n]+)>?(\))/gu;

function isInside(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith("..") && !relation.includes("/../"));
}

export function importLocalMarkdownImages(
  markdown: string,
  media: MediaStore,
  allowedRoots: string[],
  imported = new Map<string, string>(),
): string {
  const roots = allowedRoots.flatMap((root) => {
    try { return [realpathSync(root)]; } catch { return []; }
  });

  return markdown.replace(MARKDOWN_IMAGE, (match, prefix: string, rawPath: string, suffix: string) => {
    const candidate = resolve(rawPath);
    if (!IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase()) || !existsSync(candidate)) return match;

    let realPath: string;
    try {
      realPath = realpathSync(candidate);
      if (!statSync(realPath).isFile() || !roots.some((root) => isInside(realPath, root))) return match;
    } catch {
      return match;
    }

    let name = imported.get(realPath);
    if (!name) {
      name = media.importFile(realPath);
      imported.set(realPath, name);
    }
    return `${prefix}/media/${name}${suffix}`;
  });
}
