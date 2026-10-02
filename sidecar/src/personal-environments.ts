import type {Database} from 'bun:sqlite';import {readFileSync} from 'node:fs';import {homedir} from 'node:os';import {join} from 'node:path';
import type {ProjectStore} from './stores/projects';import type {ConversationStore} from './stores/conversations';import {trunkOf} from './trunk';import {projectCwd} from './workspace';
export interface EnvironmentConfig {name:string;type:'http'|'ssh-systemd'|'ssh-docker';url?:string;versionUrl?:string;host?:string;service?:string;directory?:string;ticketId?:string}
export interface ProbeResult {healthy:boolean;latencyMs:number;status?:number;commit?:string;errors:string[]}
export function incidentFingerprint(message:string){return new Bun.CryptoHasher('sha256').update(message.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,'<uuid>').replace(/\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?/g,'<time>').replace(/\b\d+\b/g,'<n>').trim()).digest('hex')}
export function sshHosts(config:string){return [...new Set([...config.matchAll(/^\s*Host\s+(.+)$/gmi)].flatMap(x=>x[1]!.split(/\s+/)).filter(x=>/^[\w.-]+$/.test(x)))]}
export function readSshHosts(){try{return sshHosts(readFileSync(join(homedir(),'.ssh/config'),'utf8'))}catch{return []}}
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
export function sshProbeCommands(config:EnvironmentConfig,since:string){
 if(!config.host||!/^[\w.-]+$/.test(config.host)||!config.service||!/^[\w.@-]+$/.test(config.service))throw new Error('hôte ou service invalide');
 if(config.directory&&(!config.directory.startsWith('/')||config.directory.includes('\0')))throw new Error('répertoire invalide');
 const service=quote(config.service),commands=config.type==='ssh-systemd'?[`systemctl is-active -- ${service}`,config.directory?`git -C ${quote(config.directory)} rev-parse HEAD`:null,`journalctl -u ${service} -p err --since ${quote(since)} --no-pager -n 200`]:[`docker inspect --format '{{.State.Status}}' ${service}`,`docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' ${service}`,`docker logs --since ${quote(since)} --tail 200 ${service} 2>&1`];
 return commands;
}
export async function probeEnvironment(config:EnvironmentConfig,since:string,exec:(host:string,command:string)=>Promise<string>,http:typeof fetch=fetch):Promise<ProbeResult>{
 const start=Date.now();
 if(config.type==='http'){
  const response=await http(config.url!,{signal:AbortSignal.timeout(15000),redirect:'error'});
  let commit:string|undefined;
  if(config.versionUrl){const version=await http(config.versionUrl,{signal:AbortSignal.timeout(15000)});if(version.ok){const body=await version.text();try{const parsed=JSON.parse(body);commit=parsed.commit??parsed.sha}catch{commit=body.trim()}}}
  return {healthy:response.ok,status:response.status,latencyMs:Date.now()-start,commit,errors:[]};
 }
 const commands=sshProbeCommands(config,since),results:string[]=[];
 for(const command of commands)results.push(command?await exec(config.host!,command):'');
 return {healthy:/^(active|running)\s*$/.test(results[0]!),latencyMs:Date.now()-start,commit:results[1]!.trim(),errors:results[2]!.split('\n').filter(line=>line.trim()&&(config.type==='ssh-systemd'||/error|panic/i.test(line)))};
}
async function sshExec(host:string,command:string){
 const child=Bun.spawn(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','--',host,command],{stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),20000);
 try{const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);const code=await child.exited;if(code!==0&&code!==3)throw new Error(err.slice(-2000)||`SSH ${code}`);return out;}finally{clearTimeout(timer)}
}
export class PersonalEnvironments {
 private busy=false;
 constructor(private db:Database,private projects:ProjectStore,private conversations:ConversationStore,private probe:(config:EnvironmentConfig,since:string)=>Promise<ProbeResult>=(config,since)=>probeEnvironment(config,since,sshExec)){
  db.exec(`CREATE TABLE IF NOT EXISTS personal_environments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,config TEXT NOT NULL,result TEXT,last_polled_at TEXT);
  CREATE TABLE IF NOT EXISTS personal_incidents(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL REFERENCES personal_environments(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,message TEXT NOT NULL,count INTEGER NOT NULL,first_at TEXT NOT NULL,last_at TEXT NOT NULL,conversation_id TEXT,UNIQUE(environment_id,fingerprint));`);
 }
 list(projectId:string){return (this.db.query('SELECT * FROM personal_environments WHERE project_id=?').all(projectId) as Array<{id:string;config:string;result:string|null}>).map(row=>({...row,config:JSON.parse(row.config),result:row.result?JSON.parse(row.result):null,incidents:this.db.query('SELECT * FROM personal_incidents WHERE environment_id=? ORDER BY last_at DESC').all(row.id)}))}
 save(projectId:string,config:EnvironmentConfig){
  if(!this.projects.get(projectId)||!config.name?.trim()||!['http','ssh-systemd','ssh-docker'].includes(config.type))throw new Error('configuration invalide');
  if(config.type==='http'){for(const value of [config.url,config.versionUrl].filter(Boolean)){const url=new URL(value!);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('URL invalide')}if(!config.url)throw new Error('URL requise');}
  else {sshProbeCommands(config,new Date().toISOString());if(!readSshHosts().includes(config.host!))throw new Error('hôte absent de ~/.ssh/config')}
  if(config.ticketId&&!this.db.query('SELECT 1 FROM tickets WHERE id=? AND project_id=?').get(config.ticketId,projectId))throw new Error('chantier invalide');
  const id=crypto.randomUUID();this.db.query('INSERT INTO personal_environments(id,project_id,config) VALUES (?,?,?)').run(id,projectId,JSON.stringify(config));return id;
 }
 async poll(id:string){
  const row=this.db.query('SELECT * FROM personal_environments WHERE id=?').get(id) as {project_id:string;config:string;last_polled_at:string|null}|null;if(!row)throw new Error('environnement inconnu');
  const config=JSON.parse(row.config) as EnvironmentConfig;const at=new Date().toISOString();
  try{
   const result=await this.probe(config,row.last_polled_at??new Date(Date.now()-300000).toISOString());let behind:number|null=null;
   const project=this.projects.get(row.project_id)!;const trunk=trunkOf(project.path,project.trunk_branch);
   if(result.commit&&/^[a-f0-9]{40,64}$/i.test(result.commit)&&trunk){const diff=Bun.spawnSync(['git','rev-list','--count',`${result.commit}..${trunk}`],{cwd:projectCwd(project),stdout:'pipe',stderr:'pipe'});if(!diff.exitCode)behind=Number(diff.stdout.toString().trim())}
   this.db.transaction(()=>{
    this.db.query('UPDATE personal_environments SET result=?,last_polled_at=? WHERE id=?').run(JSON.stringify({...result,behind}),at,id);
    for(const message of result.errors)this.db.query(`INSERT INTO personal_incidents VALUES (?,?,?,?,1,?,?,NULL) ON CONFLICT(environment_id,fingerprint) DO UPDATE SET count=count+1,last_at=excluded.last_at`).run(crypto.randomUUID(),id,incidentFingerprint(message),message.slice(0,8000),at,at);
   })();return {...result,behind};
  }catch(error){const result={healthy:false,error:String(error),latencyMs:null,behind:null};this.db.query('UPDATE personal_environments SET result=? WHERE id=?').run(JSON.stringify(result),id);return result;}
 }
 async scan(){if(this.busy)return;this.busy=true;try{for(const row of this.db.query('SELECT id FROM personal_environments').all() as {id:string}[])await this.poll(row.id)}finally{this.busy=false}}
 triage(id:string){const incident=this.db.query('SELECT i.*,e.project_id,e.config FROM personal_incidents i JOIN personal_environments e ON e.id=i.environment_id WHERE i.id=?').get(id) as {project_id:string;config:string;message:string;conversation_id:string|null}|null;if(!incident)throw new Error('incident inconnu');if(incident.conversation_id)return this.conversations.get(incident.conversation_id);const config=JSON.parse(incident.config) as EnvironmentConfig;const conversation=this.conversations.create({projectId:incident.project_id,provider:'codex',model:'gpt-6-luna',ticketId:config.ticketId??null,firstMessage:`Triage de ${config.name}. Erreur à analyser :\n${incident.message}`});this.db.query('UPDATE personal_incidents SET conversation_id=? WHERE id=?').run(conversation.id,id);return conversation;}
 async handle(request:Request,pathname:string){
  const match=pathname.match(/^\/api\/projects\/([^/]+)\/personal-environments(?:\/([^/]+))?$/);const incident=pathname.match(/^\/api\/personal-incidents\/([^/]+)\/triage$/);
  if(!match&&!incident)return null;
  try{if(incident&&request.method==='POST')return Response.json(this.triage(incident[1]!));if(!match)return null;
   const [,project,id]=match;if(id&&!this.db.query('SELECT 1 FROM personal_environments WHERE id=? AND project_id=?').get(id,project!))throw new Error('environnement inconnu');
   if(request.method==='GET')return Response.json({environments:this.list(project!),hosts:readSshHosts()});
   if(request.method==='POST'&&id)return Response.json(await this.poll(id));
   if(request.method==='POST')return Response.json({id:this.save(project!,await request.json() as EnvironmentConfig)});
   if(request.method==='DELETE'&&id){this.db.query('DELETE FROM personal_environments WHERE id=?').run(id);return Response.json({ok:true})}
   return null;
  }catch(error){return Response.json({error:String(error)},{status:400})}
 }
}
