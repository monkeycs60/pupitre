import { describe, expect, test } from "bun:test";
import { isScanRunning } from "../../ui/src/reviewStatus";

describe("isScanRunning", () => {
  test("false quand le statut n'est pas encore connu", () => {
    expect(isScanRunning(null)).toBe(false);
    expect(isScanRunning(undefined)).toBe(false);
  });

  test("false quand aucun scan ne tourne", () => {
    expect(isScanRunning({ running: null, openBySeverity: { red: 0, orange: 0, grey: 0 } })).toBe(false);
  });

  test("true quand un scan tourne", () => {
    expect(isScanRunning({
      running: { reviewId: "r1", zoneDone: 1, zoneTotal: 3 },
      openBySeverity: { red: 0, orange: 0, grey: 0 },
    })).toBe(true);
  });
});
