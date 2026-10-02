import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { TodoStore } from "../src/stores/todos";
import { BacklogHarvest, remainingItems } from "../src/backlog-harvest";
test('trois propositions sont idempotentes, la preuve de commit pose un badge sans supprimer',async()=>{
 const root=mkdtempSync(join(tmpdir(),'harvest-'));const db=openDb(root);
 try{
 const projects=new ProjectStore(db),conversations=new ConversationStore(db),todos=new TodoStore(db);const p=projects.create({name:'Test',path:root});const c=conversations.create({projectId:p.id,provider:'claude',model:'test',firstMessage:'Faire'});
 const service=new BacklogHarvest(db,conversations,projects,todos,async()=>({duplicateId:null}));
 const content='## Implémenté\n- Base\n```json\n'+JSON.stringify({remaining:[{title:'Tests',detail:'Ajouter tests'},{title:'Aide',detail:'Écrire aide'},{title:'UX',detail:'Vérifier UX'}]})+'\n```';
 expect((await service.harvest(c.id,content)).includes('```json')).toBe(false);await service.harvest(c.id,content);expect(todos.list(p.id)).toHaveLength(3);expect(todos.list(p.id).every(x=>x.proposed)).toBe(true);
 expect(remainingItems('## À terminer\n- A\n- B').remaining).toHaveLength(2);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
