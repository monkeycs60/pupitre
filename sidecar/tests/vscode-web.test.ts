import { expect, test } from "bun:test";
import { injectBridge } from "../src/vscode-web-proxy";
import { vscodeWebPath } from "../src/vscode-web";

test("ouvre le workspace de la conversation, ou son dossier, sous le préfixe relayé par le sidecar", () => {
  expect(vscodeWebPath({ workspace: "/data/editor-workspaces/mono feature.code-workspace" }))
    .toBe("/vscode-web/?workspace=%2Fdata%2Feditor-workspaces%2Fmono+feature.code-workspace");
  expect(vscodeWebPath({ folder: "/home/c/projet" })).toBe("/vscode-web/?folder=%2Fhome%2Fc%2Fprojet");
});

test("ajoute à la page de VS Code le raccourci de retour au fil, sous le nonce de sa politique de sécurité", () => {
  const page = '<html><head><script nonce="abc">boot()</script></head><body></body></html>';
  const bridged = injectBridge(page);
  expect(bridged).toContain('<script nonce="abc">addEventListener(\'keydown\'');
  expect(bridged).toContain("pupitre:conversation");
  expect(bridged.indexOf("pupitre:conversation")).toBeLessThan(bridged.indexOf("</head>"));
  expect(injectBridge("<html><head></head></html>")).toBe("<html><head></head></html>");
  expect(injectBridge("<html><head><script>boot()</script></head></html>", "script-src 'self' 'nonce-1nline-m4p'"))
    .toContain('<script nonce="1nline-m4p">addEventListener');
});
