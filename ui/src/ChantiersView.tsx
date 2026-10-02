import { ProjectDevlog } from './ProjectDevlog'
import { useState } from 'react'
import { launchRequest } from './api'
import type { Project } from './types'

type Chantier = { id:string; key:string; title:string; archived_at:string|null; payload:{description?:string} }
export function ChantiersView({ project, onStartConversation }: {project:Project;onStartConversation:(seed:{ticketId:string;ticketKey:string;branch:null})=>void}) {
  const [items,setItems]=useState<Chantier[]>([])
  const [loaded,setLoaded]=useState(false)
  const [error,setError]=useState('')
  const [title,setTitle]=useState('')
  const [description,setDescription]=useState('')
  const [editing,setEditing]=useState<string|null>(null)
  const base=`/api/projects/${project.id}/chantiers`
  async function load(){try{setItems(await launchRequest<Chantier[]>(base));setLoaded(true);setError('')}catch(error){setError(String(error))}}
  async function change(id:string,body:unknown){try{await launchRequest(`${base}/${id}`,'PUT',body);await load()}catch(error){setError(String(error))}}
  async function save(){try{await launchRequest(`${base}${editing?`/${editing}`:''}`,editing?'PUT':'POST',{title,description});setTitle('');setDescription('');setEditing(null);await load()}catch(error){setError(String(error))}}
  const render=(item:Chantier)=><div className="chantier-row" key={item.id}>
    <strong>◇ {item.title}</strong><span>{item.key}</span><p>{item.payload.description}</p>
    <button className="secondary-button" onClick={()=>onStartConversation({ticketId:item.id,ticketKey:item.key,branch:null})}>Reprendre</button>
    <button className="secondary-button" onClick={()=>{setEditing(item.id);setTitle(item.title);setDescription(item.payload.description??'')}}>Modifier</button>
    <button className="secondary-button" onClick={()=>void change(item.id,{closed:!item.archived_at})}>{item.archived_at?'Rouvrir':'Fermer le chantier'}</button>
    <label>Fusionner dans<select value="" onChange={(event)=>{if(event.target.value)void change(item.id,{mergeInto:event.target.value})}}><option value="">Choisir…</option>{items.filter(x=>x.id!==item.id).map(x=><option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
  </div>
  return <section aria-label="Chantiers" className="chantiers-view">
    <ProjectDevlog projectId={project.id} />
    <button className="secondary-button" onClick={()=>void load()}>{loaded?'Actualiser':'Afficher les chantiers'}</button>
    {error&&<p role="alert">{error}</p>}
    {items.filter(x=>!x.archived_at).map(render)}
    <details><summary>Chantiers fermés ({items.filter(x=>x.archived_at).length})</summary>{items.filter(x=>x.archived_at).map(render)}</details>
    <label>Titre du chantier<input value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Description<textarea value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <button className="primary-button" disabled={!title.trim()} onClick={()=>void save()}>{editing?'Enregistrer':'Créer un chantier'}</button>
  </section>
}
export function ChantierAssignment({projectId,conversationId}:{projectId:string;conversationId:string}){
  const [items,setItems]=useState<Chantier[]>([])
  const [open,setOpen]=useState(false)
  const [error,setError]=useState('')
  async function load(){try{setItems(await launchRequest<Chantier[]>(`/api/projects/${projectId}/chantiers`));setOpen(!open)}catch(error){setError(String(error))}}
  async function assign(id:string){try{await launchRequest(`/api/projects/${projectId}/chantiers/${id}`,'PUT',{conversationId});setOpen(false)}catch(error){setError(String(error))}}
  return <div><button className="secondary-button" onClick={()=>void load()}>Chantier…</button>{open&&<select aria-label="Déplacer vers un chantier" defaultValue="" onChange={event=>void assign(event.target.value)}><option disabled value="">Choisir un chantier</option>{items.map(item=><option value={item.id} key={item.id}>{item.title}</option>)}</select>}{error&&<p role="alert">{error}</p>}</div>
}
