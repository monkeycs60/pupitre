import { expect, test } from "bun:test";
import { reasonixPermissionAllowed } from "../src/adapters/reasonix";

const base = { cwd: "/repo/wt", extraWorkspaceRoots: ["/repo/main"] };
const outside = { kind: "execute", rawInput: { command: "touch /etc/x", additional_write_dirs: ["/etc"] } };
const inside = { kind: "edit", rawInput: { path: "/repo/main/src/a.ts" }, locations: [{ path: "/repo/main/src/a.ts" }] };

test("YOLO et accès système complet acceptent tout, y compris hors du projet", () => {
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "bypassPermissions" }, outside)).toBe(true);
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "dontAsk", filesystemScope: "full-system" }, outside)).toBe(true);
});

test("Autonome accepte dans le périmètre du projet et refuse au-delà", () => {
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "dontAsk" }, inside)).toBe(true);
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "dontAsk" }, outside)).toBe(false);
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "dontAsk" }, {
    kind: "edit",
    rawInput: { path: "/repo/wt-evil/a.ts" },
  })).toBe(false);
});

test("Éditions acceptées refuse les commandes, Plan refuse tout", () => {
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "acceptEdits" }, inside)).toBe(true);
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "acceptEdits" }, { kind: "execute", rawInput: { command: "ls" } })).toBe(false);
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "plan" }, inside)).toBe(false);
});
