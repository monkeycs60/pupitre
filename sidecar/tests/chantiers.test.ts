import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { TicketStore } from "../src/stores/tickets";
import { TodoStore } from "../src/stores/todos";
import { ChantierService, chantierDecision } from "../src/chantiers";
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'chantiers-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const db=openDb(dir);cleanup.push(()=>db.close());const projects=new ProjectStore(db),conversations=new ConversationStore(db),tickets=new TicketStore(db);
 const project=projects.create({name:'Test',path:dir});
 const service=new ChantierService(db,projects,conversations,tickets,async()=>({chantierId:null,new:{title:'Moteur Rust',description:'Migration'},confidence:0.8}));
 const conv=()=>conversations.create({projectId:project.id,provider:'claude',model:'test',firstMessage:'Migrer le moteur'});
 return {db,project,service,conv,tickets,conversations};
}
test('fermeture, réouverture, verrouillage et priorité au ticket externe',()=>{
 const {db,project,service,conv,tickets,conversations}=fixture();
 const a=service.create(project.id,'Moteur Rust'),b=service.create(project.id,'Interface web');const c=conv();
 service.assign(c.id,a.id,true);expect(service.assign(c.id,b.id)).toBe(false);expect(conversations.get(c.id)?.ticket_id).toBe(a.id);
 db.query("UPDATE conversations SET updated_at='2020-01-01' WHERE id=?").run(c.id);expect(service.closeIdle()).toBe(1);
 service.assign(c.id,a.id,true);expect(tickets.get(a.id)?.archived_at).toBeNull();
 const external=tickets.upsert(project.id,{key:'TECH-12',source:'clickup',title:'Externe',status:'',externalUrl:null});
 const other=conv();tickets.linkConversation(other.id,external.id);expect(service.assign(other.id,a.id)).toBe(false);
 db.query("UPDATE tickets SET last_seen_at='2020-01-01' WHERE id=?").run(a.id);tickets.archiveStale(project.id);expect(tickets.get(a.id)?.archived_at).toBeNull();
});
test('fusion conserve conversations, notes, consignes et backlog',()=>{
 const {db,project,service,conv,tickets,conversations}=fixture();const a=service.create(project.id,'Moteur Rust'),b=service.create(project.id,'Serveur Rust');
 const c=conv();service.assign(c.id,a.id,true);tickets.setInstruction(a.id,'Tester');
 const todos=new TodoStore(db);const todo=todos.create(project.id,{message:'Finir',provider:'claude',model:'test',ticketId:a.id,status:'backlog'});
 service.merge(a.id,b.id);expect(tickets.get(a.id)).toBeNull();expect(conversations.get(c.id)?.ticket_id).toBe(b.id);expect(todos.get(todo.id)?.ticket_id).toBe(b.id);expect(tickets.get(b.id)?.instruction).toBe('Tester');
 expect(()=>service.merge(b.id,b.id)).toThrow('invalide');
});
test('valide les décisions du modèle et refuse les confiances hors limites',()=>{
 expect(chantierDecision({chantierId:null,new:null,confidence:2})).toBeNull();expect(chantierDecision({chantierId:'abc',new:null,confidence:0.5})?.confidence).toBe(0.5);
});
test('sur le tronc deux conversations sont nécessaires et le scan ne répète pas le modèle',async()=>{
 const {project,service,conv,conversations}=fixture();const a=conv(),b=conv();
 conversations.appendEvent(a.id,{type:'user-message',text:'Moteur Rust',images:[]});conversations.appendEvent(b.id,{type:'user-message',text:'Moteur Rust',images:[]});
 expect(await service.classify(a.id)).toBe(false);expect(service.list(project.id)).toHaveLength(0);
 expect(await service.classify(a.id)).toBe(false);
 expect(await service.classify(b.id)).toBe(true);expect(service.list(project.id)).toHaveLength(1);
 expect(conversations.get(a.id)?.ticket_id).toBe(conversations.get(b.id)?.ticket_id);
});
