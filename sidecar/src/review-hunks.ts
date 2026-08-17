import { createHash } from "node:crypto";

export function hashHunk(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Hachés de tous les hunks d'un diff, dans le découpage exact qu'utilise
 * `hunkHashFor` : un flag ancré sur un hunk absent de cet ensemble porte sur du
 * code que le diff courant ne montre plus.
 */
export function diffHunkHashes(diff: string): Set<string> {
  const hashes = new Set<string>();
  for (const patch of diff.split(/(?=^diff --git )/m)) {
    if (patch.trim() === "") continue;
    const lines = patch.split("\n");
    const first = lines.findIndex((line) => line.startsWith("@@ "));
    if (first < 0) continue;
    let current: string[] | null = null;
    for (const line of lines.slice(first)) {
      if (line.startsWith("@@ ")) {
        if (current) hashes.add(hashHunk(current.join("\n")));
        current = [line];
      } else current?.push(line);
    }
    if (current) hashes.add(hashHunk(current.join("\n")));
  }
  return hashes;
}
