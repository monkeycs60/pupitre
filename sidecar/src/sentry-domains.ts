import { readFileSync } from "node:fs";
import type { Ticket } from "./stores/tickets";
import type { RelevanceReason, SentryRelevance } from "./stores/sentry";
export interface DomainDefinition { name:string; aliases:string[]; skillPath?:string|null }
export interface DomainCatalog { domains:Array<{name:string;signals:string[]}>; tickets:Array<{key:string;signals:string[]}> }
const BACKTICK=/`([^`\n]+)`/g;
function terms(text:string):string[]{return [...new Set(text.toLowerCase().split(/[^a-z0-9_./:-]+/i).filter(x=>x.length>=4))]}
export function compileDomainCatalog(domains:DomainDefinition[],tickets:Ticket[]):DomainCatalog {
 return {domains:domains.map(d=>{let skill="";try{skill=d.skillPath?readFileSync(d.skillPath,"utf8"):""}catch{}const explicit=[...skill.matchAll(BACKTICK)].map(m=>m[1]!).filter(x=>x.startsWith("/")||x.includes("/")||x.endsWith(".js")||x.endsWith(".tsx"));return{name:d.name,signals:[...new Set([...d.aliases.map(x=>x.toLowerCase()),...explicit.map(x=>x.toLowerCase())])]}}),tickets:tickets.map(t=>({key:t.key,signals:terms([t.title,String(t.payload.labels??""),String((t.payload.domainContext as any)?.text??"")].join(" "))}))};
}
export function classifySentryIssue(issue:{title?:string;transaction?:string|null;culprit?:string|null},frames:string[],catalog:DomainCatalog):SentryRelevance {
 const hay=[issue.title,issue.transaction,issue.culprit,...frames].filter(Boolean).join(" ").toLowerCase();const reasons:RelevanceReason[]=[];
 for(const d of catalog.domains){const matches=d.signals.filter(s=>s.length>=4&&hay.includes(s));if(matches.some(s=>s.includes("/")||s.endsWith(".js")||s.endsWith(".tsx")||hay.includes(`/${s}/`))||matches.length>=2)reasons.push(...matches.slice(0,3).map(signal=>({domain:d.name,signal})));}
 for(const t of catalog.tickets){const match=t.signals.find(s=>hay.includes(s));if(match)reasons.push({domain:`Ticket ${t.key}`,signal:match});}
 return {matched:reasons.length>0,reasons};
}
