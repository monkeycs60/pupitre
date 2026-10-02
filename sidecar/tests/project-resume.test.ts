import { expect,test } from 'bun:test';
import { mkdtempSync,rmSync } from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openDb} from '../src/db';import {ProjectStore} from '../src/stores/projects';import {TicketStore} from '../src/stores/tickets';import {ConversationStore} from '../src/stores/conversations';import {ProjectResumeService} from '../src/project-resume';
test('la reprise suit l’inactivité et ne régénère que si les entrées changent',async()=>{
 const root=mkdtempSync(join(tmpdir(),'resume-'));const db=openDb(root);
 try{const projects=new ProjectStore(db),tickets=new TicketStore(db),convs=new ConversationStore(db);const p=projects.create({name:'Test',path:root});const c=convs.create({projectId:p.id,provider:'claude',model:'x',firstMessage:'Test'});const t=tickets.upsert(p.id,{key:'CH-1',source:'chantier',title:'Moteur Rust',status:'',externalUrl:null});tickets.linkConversation(c.id,t.id);let calls=0;const service=new ProjectResumeService(db,projects,tickets,async()=>{calls++;return 'Reprise du moteur'});
 expect(service.inputs(p.id).showAutomatically).toBe(false);db.query("UPDATE conversations SET updated_at='2020-01-01' WHERE id=?").run(c.id);expect(service.inputs(p.id).showAutomatically).toBe(true);
 await service.get(p.id);await service.get(p.id);expect(calls).toBe(1);tickets.setInstruction(t.id,'Vérifier tests');await service.get(p.id);expect(calls).toBe(2);
 }finally{db.close();rmSync(root,{recursive:true,force:true})}
});
