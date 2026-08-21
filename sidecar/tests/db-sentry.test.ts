import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

test("crée les tables Sentry avec leur unicité par intégration", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-sentry-")));
  const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map((r) => r.name);
  expect(names).toEqual(expect.arrayContaining(["integration_secrets", "sentry_issues", "sentry_triages"]));
  db.query("INSERT INTO projects (id,name,path,created_at) VALUES ('p','P','/tmp/p-sentry','2026-01-01')").run();
  db.query("INSERT INTO project_integrations (id,project_id,type,config_json,status,created_at,updated_at) VALUES ('i','p','sentry','{}','ok','2026-01-01','2026-01-01')").run();
  const insert = db.query("INSERT INTO sentry_issues (id,integration_id,project_id,sentry_issue_id,payload_json,lifecycle,first_seen_at,last_seen_at,last_scanned_at) VALUES (?, 'i','p','42','{}','new','x','x','x')");
  insert.run("a");
  expect(() => insert.run("b")).toThrow();
});

test("supprimer le projet cascade les secrets et issues", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-sentry-")));
  db.query("INSERT INTO projects (id,name,path,created_at) VALUES ('p','P','/tmp/p-cascade','2026-01-01')").run();
  db.query("INSERT INTO project_integrations (id,project_id,type,config_json,status,created_at,updated_at) VALUES ('i','p','sentry','{}','ok','2026-01-01','2026-01-01')").run();
  db.query("INSERT INTO integration_secrets VALUES ('i','token','secret','x')").run();
  db.query("INSERT INTO sentry_issues (id,integration_id,project_id,sentry_issue_id,payload_json,lifecycle,first_seen_at,last_seen_at,last_scanned_at) VALUES ('s','i','p','42','{}','new','x','x','x')").run();
  db.query("INSERT INTO sentry_triages (issue_id,status,created_at,updated_at) VALUES ('s','idle','x','x')").run();
  db.query("DELETE FROM projects WHERE id='p'").run();
  expect((db.query("SELECT count(*) n FROM integration_secrets").get() as {n:number}).n).toBe(0);
  expect((db.query("SELECT count(*) n FROM sentry_issues").get() as {n:number}).n).toBe(0);
});
