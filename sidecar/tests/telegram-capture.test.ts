import {expect,test} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openDb} from '../src/db';import {ProjectStore} from '../src/stores/projects';import {TicketStore} from '../src/stores/tickets';import {TodoStore} from '../src/stores/todos';import type {ProjectResumeService} from '../src/project-resume';import {TelegramCapture,explicitProject} from '../src/telegram-capture';
test('préfixe, dédoublonnage, liste blanche et polling interdit en dev avec API simulée',async()=>{
 const root=mkdtempSync(join(tmpdir(),'telegram-')),db=openDb(root);try{
 const projects=new ProjectStore(db),tickets=new TicketStore(db),todos=new TodoStore(db);const p=projects.create({name:'helion',path:root});const calls:string[]=[];
 const bot=new TelegramCapture(db,projects,tickets,todos,async()=>{throw new Error('le préfixe doit primer')},{get:async()=>({content:'Reprise'})} as unknown as ProjectResumeService,'dev',root,async method=>{calls.push(method);return []});
 bot.configure(p.id,'123:fake_token','42');await bot.poll();expect(calls).toHaveLength(0);
 await bot.consume({update_id:1,message:{chat:{id:99},text:'helion : refus'}});expect(todos.list()).toHaveLength(0);
 const update={update_id:2,message:{chat:{id:42},text:'helion : les bots devraient fuir'}};await bot.consume(update);await bot.consume(update);expect(todos.list()).toHaveLength(1);expect(todos.list()[0]?.project_id).toBe(p.id);expect(calls).toEqual(['sendMessage']);
 await bot.consume({update_id:3,callback_query:{id:'cb',message:{chat:{id:42}},data:'queue:2'}});expect(todos.list()[0]?.status).toBe('queued');expect(explicitProject(' HELION : idée',projects.list())?.id).toBe(p.id);
 expect(bot.status()).toEqual({configured:true,chatId:'42',polling:false});expect(JSON.stringify(bot.status())).not.toContain('fake_token');
 }finally{db.close();rmSync(root,{recursive:true,force:true})}
});
