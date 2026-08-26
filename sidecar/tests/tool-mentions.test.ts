import { describe, expect, test } from "bun:test";
import { withToolMentions } from "../src/tool-mentions";

describe("withToolMentions", () => {
  test("oriente @chrome vers le plugin Chrome de Codex", () => {
    expect(withToolMentions("Ouvre la page avec @chrome", "codex"))
      .toContain("plugin Chrome de Codex");
  });

  test("oriente @chrome vers Claude in Chrome", () => {
    expect(withToolMentions("@chrome ouvre la page", "claude"))
      .toContain("Claude in Chrome");
  });

  test("ne modifie pas une adresse ou un mot contenant chrome", () => {
    expect(withToolMentions("contacte chrome@example.com", "codex"))
      .toBe("contacte chrome@example.com");
  });
});
