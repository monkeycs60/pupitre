import { expect, test } from "bun:test";
import {
  isEvidenceBlockedGit,
  reasonixPermissionAllowed,
  reasonixPermissionOption,
  reasonixPromptWithPerimeter,
} from "../src/adapters/reasonix";

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

test("une autorisation vaut pour la session, jamais pour le reasonix.toml du dépôt", () => {
  const writeOptions = [
    { optionId: "reasonix_write_once", kind: "allow_once" },
    { optionId: "reasonix_write_project", kind: "allow_always" },
    { optionId: "reasonix_write_session", kind: "allow_always" },
    { optionId: "reasonix_write_deny", kind: "reject_once" },
  ];
  expect(reasonixPermissionOption(writeOptions, true)?.optionId).toBe("reasonix_write_session");
  expect(reasonixPermissionOption(writeOptions, false)?.optionId).toBe("reasonix_write_deny");
  expect(reasonixPermissionOption([{ optionId: "allow_once", kind: "allow_once" }], true)?.optionId).toBe("allow_once");
});

test("le prompt annonce le périmètre d'écriture hors YOLO, Plan et accès système", () => {
  const withPerimeter = reasonixPromptWithPerimeter("go", { ...base, permissionMode: "acceptEdits" });
  expect(withPerimeter).toStartWith("[Pupitre] Écritures autorisées uniquement dans : /repo/wt, /repo/main.");
  expect(withPerimeter).toContain("Les commandes shell seront refusées.");
  expect(withPerimeter).toEndWith("\n\ngo");
  expect(reasonixPromptWithPerimeter("go", { ...base, permissionMode: "dontAsk" })).not.toContain("commandes");
  expect(reasonixPromptWithPerimeter("go", { ...base, permissionMode: "bypassPermissions" })).toBe("go");
  expect(reasonixPromptWithPerimeter("go", { ...base, permissionMode: "dontAsk", filesystemScope: "full-system" })).toBe("go");
});

test("Éditions acceptées refuse les commandes, Plan refuse tout", () => {
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "acceptEdits" }, inside)).toBe(true);
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "acceptEdits" }, { kind: "execute", rawInput: { command: "ls" } })).toBe(false);
  expect(reasonixPermissionAllowed({ ...base, permissionMode: "plan" }, inside)).toBe(false);
});

test("seul un git refusé par la garde read-evidence déclenche le rappel de git_commit", () => {
  const blocked = "blocked: [evidence required] bash cannot declare which files it changes while a read-evidence requirement is outstanding (/repo/a.ts)";
  expect(isEvidenceBlockedGit({ command: "git add a.ts && git commit -m x" }, blocked)).toBe(true);
  expect(isEvidenceBlockedGit({ command: "sed -i s/a/b/ a.ts" }, blocked)).toBe(false);
  expect(isEvidenceBlockedGit({ command: "git add a.ts" }, "")).toBe(false);
  expect(isEvidenceBlockedGit({ path: "/repo/a.ts" }, blocked)).toBe(false);
});
