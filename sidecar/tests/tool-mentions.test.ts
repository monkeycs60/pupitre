import { describe, expect, test } from "bun:test";
import { withToolMentions } from "../src/tool-mentions";

describe("withToolMentions", () => {
  test("oriente @browser vers le skill agent-browser pour Codex", () => {
    expect(withToolMentions("Ouvre la page avec @browser", "codex"))
      .toContain("skill agent-browser");
  });

  test("oriente @browser vers le skill agent-browser pour Claude", () => {
    expect(withToolMentions("@browser ouvre la page", "claude"))
      .toContain("skill agent-browser");
  });

  test("ne modifie pas une adresse ou un mot contenant browser", () => {
    expect(withToolMentions("contacte browser@example.com", "codex"))
      .toBe("contacte browser@example.com");
  });

  test("ne réagit plus à @chrome", () => {
    expect(withToolMentions("Ouvre la page avec @chrome", "claude"))
      .toBe("Ouvre la page avec @chrome");
  });
});
