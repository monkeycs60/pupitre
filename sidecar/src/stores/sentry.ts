import type { Database } from "bun:sqlite";

export type SentryLifecycle = "new" | "active" | "quiet" | "resolved_remote";
export type SentryVerdict = "real_fixable" | "real_investigate" | "noise" | "uncertain";
export interface RelevanceReason { domain: string; signal: string }
export interface SentryRelevance { matched: boolean; reasons: RelevanceReason[] }
export interface SentryIssue { id:string; integration_id:string; project_id:string; sentry_issue_id:string; payload:Record<string,unknown>; relevance:SentryRelevance; lifecycle:SentryLifecycle; first_seen_at:string; last_seen_at:string; last_scanned_at:string }
export interface SentryTriage { issue_id:string; conversation_id:string|null; correction_conversation_id:string|null; ticket_id:string|null; status:"idle"|"running"|"done"|"error"; verdict:SentryVerdict|null; report:Record<string,unknown>; created_at:string; updated_at:string }

export class SentryStore {
  constructor(private readonly db: Database) {}
  transaction<T>(fn:()=>T):T { return this.db.transaction(fn)(); }
  get(id:string):SentryIssue|null { const row=this.db.query("SELECT * FROM sentry_issues WHERE id=?").get(id) as Record<string,unknown>|null; return row?hydrateIssue(row):null; }
  listProject(projectId:string):SentryIssue[] { return (this.db.query("SELECT * FROM sentry_issues WHERE project_id=? ORDER BY last_seen_at DESC").all(projectId) as Record<string,unknown>[]).map(hydrateIssue); }
  upsertIssue(input:{integrationId:string;projectId:string;sentryIssueId:string;payload:Record<string,unknown>;relevance:SentryRelevance;scannedAt:string}):SentryIssue {
    const found=this.db.query("SELECT * FROM sentry_issues WHERE integration_id=? AND sentry_issue_id=?").get(input.integrationId,input.sentryIssueId) as Record<string,unknown>|null;
    const remoteLast=typeof input.payload.lastSeen==="string"?input.payload.lastSeen:input.scannedAt;
    if (!found) { const id=crypto.randomUUID(); this.db.query(`INSERT INTO sentry_issues (id,integration_id,project_id,sentry_issue_id,payload_json,relevance_json,lifecycle,first_seen_at,last_seen_at,last_scanned_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,input.integrationId,input.projectId,input.sentryIssueId,JSON.stringify(input.payload),JSON.stringify(input.relevance),"new",input.scannedAt,remoteLast,input.scannedAt); return this.get(id)!; }
    const previous=hydrateIssue(found); const lifecycle:SentryLifecycle=remoteLast>previous.last_seen_at?"active":previous.lifecycle==="resolved_remote"?"resolved_remote":"quiet";
    this.db.query("UPDATE sentry_issues SET payload_json=?,relevance_json=?,lifecycle=?,last_seen_at=?,last_scanned_at=? WHERE id=?").run(JSON.stringify(input.payload),JSON.stringify(input.relevance),lifecycle,remoteLast,input.scannedAt,previous.id); return this.get(previous.id)!;
  }
  markMissing(integrationId:string,seen:Set<string>,resolved:Set<string>,scannedAt:string):void {
    const rows=this.db.query("SELECT id,sentry_issue_id FROM sentry_issues WHERE integration_id=?").all(integrationId) as Array<{id:string;sentry_issue_id:string}>;
    for(const row of rows) if(!seen.has(row.sentry_issue_id)) this.db.query("UPDATE sentry_issues SET lifecycle=?,last_scanned_at=? WHERE id=?").run(resolved.has(row.sentry_issue_id)?"resolved_remote":"quiet",scannedAt,row.id);
  }
  upsertTriage(issueId:string,input:{status:SentryTriage["status"];verdict?:SentryVerdict|null;report?:Record<string,unknown>;conversationId?:string|null;correctionConversationId?:string|null;ticketId?:string|null}):SentryTriage {
    const now=new Date().toISOString(); this.db.query(`INSERT INTO sentry_triages (issue_id,conversation_id,correction_conversation_id,ticket_id,status,verdict,report_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(issue_id) DO UPDATE SET conversation_id=COALESCE(excluded.conversation_id,conversation_id),correction_conversation_id=COALESCE(excluded.correction_conversation_id,correction_conversation_id),ticket_id=COALESCE(excluded.ticket_id,ticket_id),status=excluded.status,verdict=COALESCE(excluded.verdict,verdict),report_json=excluded.report_json,updated_at=excluded.updated_at`).run(issueId,input.conversationId??null,input.correctionConversationId??null,input.ticketId??null,input.status,input.verdict??null,JSON.stringify(input.report??{}),now,now); return this.triageForIssue(issueId)!;
  }
  triageForIssue(issueId:string):SentryTriage|null { const row=this.db.query("SELECT * FROM sentry_triages WHERE issue_id=?").get(issueId) as Record<string,unknown>|null; return row?hydrateTriage(row):null; }
  sweep(now=new Date()):number { const cutoff=new Date(now.getTime()-30*86400000).toISOString(); return this.db.query("DELETE FROM sentry_issues WHERE lifecycle IN ('quiet','resolved_remote') AND last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM sentry_triages WHERE issue_id=sentry_issues.id)").run(cutoff).changes; }
}
function hydrateIssue(r:Record<string,unknown>):SentryIssue { return {id:String(r.id),integration_id:String(r.integration_id),project_id:String(r.project_id),sentry_issue_id:String(r.sentry_issue_id),payload:JSON.parse(String(r.payload_json)),relevance:JSON.parse(String(r.relevance_json)),lifecycle:r.lifecycle as SentryLifecycle,first_seen_at:String(r.first_seen_at),last_seen_at:String(r.last_seen_at),last_scanned_at:String(r.last_scanned_at)}; }
function hydrateTriage(r:Record<string,unknown>):SentryTriage { return {issue_id:String(r.issue_id),conversation_id:r.conversation_id as string|null,correction_conversation_id:r.correction_conversation_id as string|null,ticket_id:r.ticket_id as string|null,status:r.status as SentryTriage["status"],verdict:r.verdict as SentryVerdict|null,report:JSON.parse(String(r.report_json)),created_at:String(r.created_at),updated_at:String(r.updated_at)}; }
