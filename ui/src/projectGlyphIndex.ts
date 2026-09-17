const PROJECT_GLYPH_COUNT = 8

export function projectGlyphIndex(projectId: string): number {
  let hash = 2166136261
  for (const character of projectId) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return ((hash ^ (hash >>> 16)) >>> 0) % PROJECT_GLYPH_COUNT
}
