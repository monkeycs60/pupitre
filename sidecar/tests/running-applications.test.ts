import { expect, test } from "bun:test";
import {
  contextForCwd,
  inspectorPort,
  isExcludedApplicationProcess,
  parseListeningSockets,
} from "../src/running-applications";

test("parse les ports IPv4 et IPv6 qui exposent un PID", () => {
  const output = [
    'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("MainThread",pid=875495,fd=24))',
    'LISTEN 0 511 *:8098 *:* users:(("node",pid=771796,fd=16))',
    'LISTEN 0 511 [::]:8098 [::]:* users:(("node",pid=771796,fd=19))',
    'LISTEN 0 128 [::]:22 [::]:*',
  ].join("\n");

  expect(parseListeningSockets(output)).toEqual([
    { pid: 875495, port: 5173, process: "MainThread" },
    { pid: 771796, port: 8098, process: "node" },
  ]);
});

test("reconnaît le port d'inspection Node implicite ou explicite", () => {
  expect(inspectorPort("node --inspect=0.0.0.0 server.js")).toBe(9229);
  expect(inspectorPort("node --inspect=9230 server.js")).toBe(9230);
  expect(inspectorPort("node --inspect-brk=127.0.0.1:9231 server.js")).toBe(9231);
  expect(inspectorPort("node server.js")).toBeNull();
});

test("écarte les navigateurs et éditeurs lancés depuis un worktree", () => {
  expect(isExcludedApplicationProcess("chrome")).toBeTrue();
  expect(isExcludedApplicationProcess("chromium-browser")).toBeTrue();
  expect(isExcludedApplicationProcess("code")).toBeTrue();
  expect(isExcludedApplicationProcess("node")).toBeFalse();
});

test("préfère le worktree le plus précis au dossier du projet", () => {
  const project = { projectId: "p1", projectName: "Affilae", root: "/code/affilae", kind: "project" as const };
  const worktree = { projectId: "p1", projectName: "Affilae", root: "/code/affilae/apps/reactor-ticket", kind: "worktree" as const };

  expect(contextForCwd("/code/affilae/apps/reactor-ticket", [project, worktree])).toEqual(worktree);
  expect(contextForCwd("/code/affilae-copy", [project, worktree])).toBeNull();
});
