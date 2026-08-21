import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { IntegrationStore } from "../src/stores/integrations";
import { IntegrationSecretStore } from "../src/stores/integration-secrets";
import { SentryStore } from "../src/stores/sentry";

let projectId: string, integrationId: string, store: SentryStore, secrets: IntegrationSecretStore;
beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-sentry-store-")));
  projectId = new ProjectStore(db).create({name:"P",path:`/tmp/p-${crypto.randomUUID()}`}).id;
  integrationId = new IntegrationStore(db).upsert(projectId,"sentry",{config:{}}).id;
  store = new SentryStore(db); secrets = new IntegrationSecretStore(db);
});

test("isole, met à jour et conserve le triage", () => {
  const first = store.upsertIssue({integrationId,projectId,sentryIssueId:"42",payload:{title:"A",lastSeen:"2026-08-20"},relevance:{matched:true,reasons:[{domain:"matching",signal:"/matching/search"}]},scannedAt:"2026-08-20T10:00:00Z"});
  store.upsertTriage(first.id,{status:"done",verdict:"noise",report:{summary:"attendu"}});
  const again = store.upsertIssue({integrationId,projectId,sentryIssueId:"42",payload:{title:"A",lastSeen:"2026-08-21"},relevance:{matched:true,reasons:[]},scannedAt:"2026-08-21T10:00:00Z"});
  expect(again.id).toBe(first.id); expect(again.lifecycle).toBe("active");
  expect(store.triageForIssue(first.id)?.verdict).toBe("noise");
});

test("secrets opaques et suppression ciblée", () => {
  secrets.set(integrationId,"token","abc"); expect(secrets.get(integrationId,"token")).toBe("abc");
  secrets.removeIntegration(integrationId); expect(secrets.get(integrationId,"token")).toBeNull();
});

test("quiet, resolved et rétention", () => {
  const old = store.upsertIssue({integrationId,projectId,sentryIssueId:"old",payload:{lastSeen:"2026-06-01"},relevance:{matched:false,reasons:[]},scannedAt:"2026-06-01T00:00:00Z"});
  const kept = store.upsertIssue({integrationId,projectId,sentryIssueId:"kept",payload:{lastSeen:"2026-06-01"},relevance:{matched:false,reasons:[]},scannedAt:"2026-06-01T00:00:00Z"});
  store.upsertTriage(kept.id,{status:"done",verdict:"uncertain",report:{}});
  store.markMissing(integrationId,new Set(),new Set(["kept"]),"2026-08-01T00:00:00Z");
  expect(store.get(old.id)?.lifecycle).toBe("quiet"); expect(store.get(kept.id)?.lifecycle).toBe("resolved_remote");
  expect(store.sweep(new Date("2026-08-01T00:00:00Z"))).toBe(1); expect(store.get(old.id)).toBeNull(); expect(store.get(kept.id)).not.toBeNull();
});
