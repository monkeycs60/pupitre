import { expect, test } from "bun:test";
import {
  LEGACY_THRESHOLDS_KEY,
  loadQuotaThresholds,
} from "../../ui/src/quotaSettings";

function storageWith(value: string | null) {
  const values = new Map<string, string>();
  if (value !== null) values.set(LEGACY_THRESHOLDS_KEY, value);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    has: (key: string) => values.has(key),
  };
}

test("lit les seuils settings sans toucher à l'ancien localStorage", async () => {
  const storage = storageWith('{"lastHour":false,"usedPercent":70}');
  let writes = 0;
  const thresholds = await loadQuotaThresholds(
    async () => ({ quotaThresholds: { lastHour: true, usedPercent: 85 } }),
    async (settings) => { writes += 1; return settings; },
    storage,
  );
  expect(thresholds).toEqual({ lastHour: true, usedPercent: 85 });
  expect(writes).toBe(0);
  expect(storage.has(LEGACY_THRESHOLDS_KEY)).toBe(true);
});

test("importe puis supprime une seule fois les seuils historiques", async () => {
  const storage = storageWith('{"lastHour":false,"usedPercent":92}');
  let saved: unknown;
  const thresholds = await loadQuotaThresholds(
    async () => ({}),
    async (settings) => { saved = settings; return settings; },
    storage,
  );
  expect(thresholds).toEqual({ lastHour: false, usedPercent: 92 });
  expect(saved).toEqual({ quotaThresholds: thresholds });
  expect(storage.has(LEGACY_THRESHOLDS_KEY)).toBe(false);
});
