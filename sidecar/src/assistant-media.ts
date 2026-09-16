import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { configuredByteLimit, DEFAULT_MEDIA_MAX_BYTES, type MediaStore } from "./media";
import { aiRoots, type FilesystemScope } from "./access";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const MARKDOWN_IMAGE = /(!\[[^\]]*\]\()(?:<(\/[^>\n]+)>|(\/(?:\\.|[^()\n]|\([^()\n]*\))+))(\))/gu;
const ATTACHMENT_IMAGE = /(!\[[^\]]*\]\()attachment(\))/gu;
const INLINE_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function isInside(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith("..") && !relation.includes("/../"));
}

export function assistantImageRoots(input: {
  filesystemScope: FilesystemScope;
  projectPath: string;
  conversationPath: string;
}, trustedAiRoots: string[] = aiRoots()): string[] {
  if (input.filesystemScope === "full-system") return ["/"];
  return [...new Set([
    "/tmp",
    input.projectPath,
    input.conversationPath,
    ...trustedAiRoots,
  ])];
}

export function importLocalMarkdownImages(
  markdown: string,
  media: MediaStore,
  allowedRoots: string[],
  imported = new Map<string, string>(),
  maxBytes = configuredByteLimit("PUPITRE_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES),
): string {
  const roots = allowedRoots.flatMap((root) => {
    try { return [realpathSync(root)]; } catch { return []; }
  });

  return markdown.replace(MARKDOWN_IMAGE, (match, prefix: string, angledPath: string | undefined, plainPath: string | undefined, suffix: string) => {
    const matchedPath = angledPath ?? plainPath;
    if (!matchedPath) return match;
    let rawPath: string;
    try {
      rawPath = decodeURIComponent(matchedPath.replace(/\\([\\()])/gu, "$1"));
    } catch {
      return match;
    }
    const candidate = resolve(rawPath);
    if (!IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase()) || !existsSync(candidate)) return match;

    let realPath: string;
    try {
      realPath = realpathSync(candidate);
      const stat = statSync(realPath);
      if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes || !roots.some((root) => isInside(realPath, root))) return match;
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

export function importInlineImages(
  images: Array<{ mediaType: string; data: string }>,
  media: MediaStore,
  maxBytes = configuredByteLimit("PUPITRE_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES),
): string[] {
  return images.flatMap(({ mediaType, data }) => {
    const extension = INLINE_IMAGE_EXTENSIONS[mediaType.toLowerCase()];
    if (!extension || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) return [];
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > maxBytes) return [];
    return [media.importBytes(bytes, extension)];
  });
}

export function resolveAttachmentImages(markdown: string, pendingImages: string[]): string {
  return markdown.replace(ATTACHMENT_IMAGE, (match, prefix: string, suffix: string) => {
    const name = pendingImages.shift();
    return name ? `${prefix}/media/${name}${suffix}` : match;
  });
}
