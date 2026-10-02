import {expect,test} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openDb} from '../src/db';import {ProjectStore} from '../src/stores/projects';import {ConversationStore} from '../src/stores/conversations';import type {HtmlDocumentService} from '../src/html-documents';import {ProjectDevlogService} from '../src/project-devlog';
test('le devlog publie un document du projet et les notes imposent un style utilisateur',async()=>{
 const root=mkdtempSync(join(tmpdir(),'devlog-'));const db=openDb(root);try{
 const projects=new ProjectStore(db),conversations=new ConversationStore(db);const p=projects.create({name:'Vrac',path:root});let prompt='',published='';
 const documents={publish:async(id:string,input:{path:string;title:string})=>{published=input.title;expect(conversations.get(id)?.project_id).toBe(p.id);expect(await Bun.file(input.path).text()).toBe('Des idées plus faciles à retrouver.');return {id:'doc'}}} as unknown as HtmlDocumentService;
 const service=new ProjectDevlogService(db,projects,conversations,documents,async text=>{prompt=text;return 'Des idées plus faciles à retrouver.'});
 await service.create(p.id,{kind:'release',from:'2026-09-01',to:'2026-09-30'});expect(prompt).toContain('Aucun nom de fichier');expect(published).toContain('Notes de version · Vrac');await expect(service.create(p.id,{from:'bad'})).rejects.toThrow('période');
 }finally{db.close();rmSync(root,{recursive:true,force:true})}
});
