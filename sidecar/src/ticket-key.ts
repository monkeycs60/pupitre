export const DEFAULT_BRANCH_PATTERN = "^[a-z]+/([A-Z][A-Z0-9]+-\\d+)";

const BASE_BRANCHES = new Set(["main", "master", "develop", "dev", "staging", "preprod", "production"]);

export function compileBranchPattern(pattern: string): RegExp {
  return new RegExp(pattern, "u");
}

export function extractTicketKey(branch: string, pattern: RegExp | null): string | null {
  const name = branch.trim();
  if (!name) return null;

  if (pattern === null) {
    return BASE_BRANCHES.has(name) ? null : name;
  }

  const match = name.match(pattern);
  if (!match) return null;

  for (let index = match.length - 1; index >= 1; index -= 1) {
    const group = match[index];
    if (group) return group;
  }

  return null;
}
