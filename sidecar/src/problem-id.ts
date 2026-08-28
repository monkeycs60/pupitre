const PROBLEM_COMMIT_MARKER = /\[(PB-[0-9A-HJKMNP-TV-Z]{6})\]/g;

export function problemIdsInCommit(message: string): string[] {
  return [...new Set([...message.matchAll(PROBLEM_COMMIT_MARKER)].map((match) => match[1]!))];
}
