import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openEditorWindows } from "../src/editor-workspace";
import { parseCitation, resolveCitations, touchedFiles } from "../src/file-citations";

const root = mkdtempSync(join(tmpdir(), "pupitre-citations-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const mono = join(root, "mono");
const hapigator = join(mono, "apps/hapigator-tech123");
const reactor = join(mono, "apps/reactor-tech123");
for (const [repository, files] of [
  [hapigator, ["lib/agent/mutations/index.js", "lib/agent/mutations/common.js", "lib/hapi/common.js", "admin/users/routes.js", "admin/chat/routes.js", "lib/auth.js"]],
  [reactor, ["source/App.tsx", "source/common.js", "auth.js"]],
] as const) {
  for (const file of files) {
    mkdirSync(dirname(join(repository, file)), { recursive: true });
    writeFileSync(join(repository, file), "x\n");
  }
  Bun.spawnSync(["git", "init", "-q"], { cwd: repository });
}
const folders = [
  { name: "mono", path: mono, branch: "feature/TECH-123" },
  { name: "hapigator", path: hapigator, branch: "feature/TECH-123" },
  { name: "reactor", path: reactor, branch: "feature/TECH-123" },
];

test("lit le chemin et la ligne d'une citation, et ignore les expressions", () => {
  expect(parseCitation("lib/auth.js:132")).toEqual({ path: "lib/auth.js", line: 132 });
  expect(parseCitation("App.tsx:850-870")).toEqual({ path: "App.tsx", line: 850 });
  expect(parseCitation("req.app.user")).toBeNull();
  expect(parseCitation(".ts")).toBeNull();
  expect(parseCitation(".env.local")).toEqual({ path: ".env.local", line: null });
  expect(parseCitation("https://x.io/a.js")).toBeNull();
});

test("résout chemins relatifs, suffixes et noms seuls, puis départage par le voisinage", async () => {
  const results = await resolveCitations(
    ["lib/auth.js:132", "mutations/index.js", "common.js:39", "routes.js", "reactor-tech123/source/App.tsx:850", "absent.js"],
    folders, mono, [mono], new Set(),
  );

  expect(results["lib/auth.js:132"]).toEqual({ status: "resolved", path: join(hapigator, "lib/auth.js"), line: 132, label: "hapigator/lib/auth.js" });
  expect(results["mutations/index.js"]).toMatchObject({ status: "resolved", path: join(hapigator, "lib/agent/mutations/index.js") });
  expect(results["common.js:39"]).toMatchObject({ status: "resolved", path: join(hapigator, "lib/agent/mutations/common.js"), line: 39 });
  expect(results["reactor-tech123/source/App.tsx:850"]).toMatchObject({ status: "resolved", path: join(reactor, "source/App.tsx") });
  expect(results["routes.js"]).toMatchObject({ status: "ambiguous", more: 0 });
  expect(results["routes.js"]!.status === "ambiguous" && results["routes.js"]!.candidates.map((item) => item.label)).toEqual([
    "hapigator/admin/chat/routes.js", "hapigator/admin/users/routes.js",
  ]);
  expect(results["absent.js"]).toEqual({ status: "missing" });
});

test("un fichier lu par l'agent l'emporte sur ses homonymes", async () => {
  const touched = touchedFiles([{ file_path: join(hapigator, "admin/users/routes.js") }, { command: "ls" }]);
  const results = await resolveCitations(["routes.js"], folders, mono, [], touched);

  expect(results["routes.js"]).toMatchObject({ status: "resolved", path: join(hapigator, "admin/users/routes.js") });
});

test("relève les dossiers et workspaces des fenêtres VS Code ouvertes", () => {
  const storage = join(root, "storage.json");
  writeFileSync(storage, JSON.stringify({
    windowsState: {
      lastActiveWindow: { folder: "file:///home/c/projet%20perso" },
      openedWindows: [
        { workspaceIdentifier: { id: "1", configURIPath: "file:///data/editor-workspaces/mono-feature-TECH-123.code-workspace" } },
        { backupPath: "/tmp/vide" },
      ],
    },
  }));

  expect([...openEditorWindows(storage)].sort()).toEqual([
    "/data/editor-workspaces/mono-feature-TECH-123.code-workspace",
    "/home/c/projet perso",
  ]);
  expect(openEditorWindows(join(root, "absent.json")).size).toBe(0);
});

test("un nom seul présent à la racine d'un dossier reste comparé à ses homonymes", async () => {
  expect((await resolveCitations(["auth.js"], folders, reactor, [], new Set()))["auth.js"]).toMatchObject({ status: "ambiguous" });
});

test("un fichier ignoré par Git se retrouve par son nom seul à la racine d'un dossier", async () => {
  writeFileSync(join(reactor, ".gitignore"), ".env\n");
  writeFileSync(join(reactor, ".env"), "SECRET=x\n");

  expect((await resolveCitations([".env"], folders, mono, [], new Set()))[".env"]).toMatchObject({ status: "resolved", path: join(reactor, ".env") });
});

test("`./chemin` se lit depuis le répertoire de travail de la conversation", async () => {
  const results = await resolveCitations(["./source/App.tsx", "./auth.js"], folders, reactor, [], new Set());

  expect(results["./source/App.tsx"]).toMatchObject({ status: "resolved", path: join(reactor, "source/App.tsx") });
  expect(results["./auth.js"]).toMatchObject({ status: "resolved", path: join(reactor, "auth.js") });
});
