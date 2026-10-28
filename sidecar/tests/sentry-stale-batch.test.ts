import { expect, test } from "bun:test";
import { staleIssueBatch } from "../src/integrations/refresher";

test("ne revérifie qu'un lot tournant des issues absentes de la liste récente", () => {
  const issues = Array.from({ length: 60 }, (_, index) => ({ sentry_issue_id: String(index).padStart(3, "0") }));
  const ids = (items: Array<{ sentry_issue_id: string }>) => items.map((item) => item.sentry_issue_id);

  expect(ids(staleIssueBatch(issues, 0))).toHaveLength(25);
  expect(ids(staleIssueBatch(issues, 0))[0]).toBe("000");
  expect(ids(staleIssueBatch(issues, 900_000))[0]).toBe("025");
  expect(ids(staleIssueBatch(issues, 2 * 900_000)).slice(9, 11)).toEqual(["059", "000"]);
  expect(staleIssueBatch(issues.slice(0, 10), 0)).toHaveLength(10);
});
