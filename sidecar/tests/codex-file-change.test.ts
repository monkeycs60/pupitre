import { expect, test } from "bun:test";
import { fileChangeEvents } from "../src/adapters/codex-app-server";

test("une modification Codex devient une action file_change portant chaque diff", () => {
  const events = fileChangeEvents({
    id: "fc-1",
    type: "fileChange",
    status: "completed",
    changes: [
      { path: "/repo/src/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
      { path: "/repo/src/b.ts", kind: { type: "add" }, diff: "export const b = 1\n" },
    ],
  });

  expect(events).toEqual([
    {
      type: "tool-start",
      toolId: "fc-1",
      toolName: "file_change",
      input: {
        changes: [
          { path: "/repo/src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" },
          { path: "/repo/src/b.ts", kind: "add", diff: "export const b = 1\n" },
        ],
      },
    },
    { type: "tool-end", toolId: "fc-1", output: "", images: [] },
  ]);
});

test("une modification refusée est une action en échec, et une modification vide n'émet rien", () => {
  const events = fileChangeEvents({
    id: "fc-2",
    status: "declined",
    changes: [{ path: "/a", kind: { type: "delete" }, diff: "x\n" }],
  });
  expect(events[1]).toEqual({ type: "tool-end", toolId: "fc-2", output: "Modification refusée", images: [], isError: true });
  expect(fileChangeEvents({ id: "fc-3", status: "completed", changes: [] })).toEqual([]);
});
