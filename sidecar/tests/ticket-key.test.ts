import { expect, test } from "bun:test";
import { extractTicketKey, DEFAULT_BRANCH_PATTERN, compileBranchPattern } from "../src/ticket-key";

test("extrait TECH-XXXXX d'une branche affilae-mono", () => {
  const pattern = compileBranchPattern("^(issue|maintenance|feature)/(TECH-\\d+)");
  expect(extractTicketKey("feature/TECH-24657", pattern)).toBe("TECH-24657");
  expect(extractTicketKey("issue/TECH-24868-publisher", pattern)).toBe("TECH-24868");
  expect(extractTicketKey("develop", pattern)).toBeNull();
});

test("la clé est le dernier groupe capturant non vide", () => {
  const pattern = compileBranchPattern("^[a-z]+/([A-Z]+-\\d+)");
  expect(extractTicketKey("feat/ABC-12-truc", pattern)).toBe("ABC-12");
});

test("sans motif, la branche entière est la clé, sauf les branches de base", () => {
  expect(extractTicketKey("feature/foo", null)).toBe("feature/foo");
  expect(extractTicketKey("main", null)).toBeNull();
  expect(extractTicketKey("develop", null)).toBeNull();
  expect(extractTicketKey("master", null)).toBeNull();
});

test("un motif invalide est refusé à la compilation", () => {
  expect(() => compileBranchPattern("(")).toThrow();
});

test("le motif par défaut reconnaît les clés JIRA/ClickUp usuelles", () => {
  const pattern = compileBranchPattern(DEFAULT_BRANCH_PATTERN);
  expect(extractTicketKey("feature/TECH-1", pattern)).toBe("TECH-1");
  expect(extractTicketKey("hotfix/OPS-42-x", pattern)).toBe("OPS-42");
});
