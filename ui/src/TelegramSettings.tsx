import {useState} from 'react'
import {launchRequest} from './api'
export function TelegramSettings({projectId}:{projectId:string}){
 const [token,setToken]=useState(''),[chatId,setChatId]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 async function save(){setBusy(true);try{const result=await launchRequest<{polling:boolean}>('/api/telegram','PUT',{projectId,token,chatId});setToken('');setMessage(result.polling?'Capture Telegram configurée.':'Configuration enregistrée. Seule l’instance stable interrogera Telegram.')}catch(error){setMessage(String(error))}finally{setBusy(false)}}
 return <details><summary>Capture Telegram</summary><p>Utilisez un bot dédié à Pupitre. Seul le chat autorisé pourra ajouter des idées au backlog.</p><label>Jeton du bot<input type="password" value={token} autoComplete="new-password" onChange={e=>setToken(e.target.value)}/></label><label>Chat autorisé<input value={chatId} onChange={e=>setChatId(e.target.value)}/></label><button type="button" className="secondary-button" disabled={busy||!token||!chatId} onClick={()=>void save()}>Configurer Telegram</button><p role="status">{message}</p></details>
}
