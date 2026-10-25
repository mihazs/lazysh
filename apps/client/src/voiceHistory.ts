import { useEffect, useRef, useState } from 'react';

export const VOICE_HISTORY_DATABASE = 'lazysh-voice-history-v1';
export const VOICE_HISTORY_AGE = 7 * 24 * 60 * 60 * 1000;
export const VOICE_HISTORY_BYTES = 256 * 1024;
const MAX_ENTRIES = 20;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type DictationEntry = {id:string;text:string;createdAt:number};
export type DictationHistory = {version:1;remember:boolean;epoch:string;entries:DictationEntry[]};
export type HistoryCapture = {revision:number;epoch:string;remember:boolean;createdAt:number};
type Action = {type:'read'} | {type:'remember';value:boolean;epoch:string;entries:DictationEntry[]}
  | {type:'add';epoch:string;entry:DictationEntry;isCurrent?:()=>boolean} | {type:'clear'|'remove';id?:string;disable?:boolean};
const empty = (): DictationHistory => ({version:1,remember:false,epoch:'',entries:[]});
function validText(text: unknown): text is string {
  return typeof text==='string' && text.length>0 && text.length<=65536 && !!text.trim()
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}
function bytes(entries: DictationEntry[]): number {
  return new TextEncoder().encode(JSON.stringify({version:1,remember:true,epoch:'0'.repeat(36),entries})).byteLength;
}
export function boundDictationHistory(entries: DictationEntry[], persistent: boolean, now=Date.now()): DictationEntry[] {
  const result=entries.filter(entry=>!persistent || (entry.createdAt<=now+5000 && now-entry.createdAt<VOICE_HISTORY_AGE)).slice(0,MAX_ENTRIES);
  while(result.length && bytes(result)>VOICE_HISTORY_BYTES)result.pop();
  return result;
}
function validate(value: unknown): DictationHistory {
  if(value===undefined)return empty();
  if(!value || typeof value!=='object')throw new Error('Invalid saved history.');
  const data=value as DictationHistory;
  if(data.version!==1 || typeof data.remember!=='boolean' || !uuid.test(data.epoch)
    || !Array.isArray(data.entries) || data.entries.length>MAX_ENTRIES
    || Object.keys(data).some(key=>!['version','remember','epoch','entries'].includes(key)))throw new Error('Invalid saved history.');
  const ids=new Set<string>();
  for(const entry of data.entries){
    if(!entry || typeof entry!=='object' || typeof entry.id!=='string' || !uuid.test(entry.id) || ids.has(entry.id)
      || !validText(entry.text) || !Number.isSafeInteger(entry.createdAt) || entry.createdAt<0 || entry.createdAt>8_640_000_000_000_000
      || Object.keys(entry).some(key=>!['id','text','createdAt'].includes(key)))throw new Error('Invalid saved history.');
    ids.add(entry.id);
  }
  if((!data.remember && data.entries.length) || bytes(data.entries)>VOICE_HISTORY_BYTES)throw new Error('Invalid saved history.');
  return data;
}
function open(): Promise<IDBDatabase> {
  if(!globalThis.indexedDB)return Promise.reject(new Error('Local history storage is unavailable.'));
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(VOICE_HISTORY_DATABASE,1);
    let blocked=false;
    request.onupgradeneeded=()=>request.result.createObjectStore('history');
    request.onerror=()=>reject(new Error('Local history storage is unavailable.'));
    request.onblocked=()=>{blocked=true;reject(new Error('Close other lazysh windows before changing history storage.'));};
    request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result);};
  });
}
// Consent checks and appends share a transaction: notifications can arrive after destructive actions.
export async function changeDictationHistory(action:Action): Promise<{history:DictationHistory;accepted:boolean}> {
  const db=await open();
  try {
    return await new Promise((resolve,reject)=>{
      const transaction=db.transaction('history','readwrite');
      const store=transaction.objectStore('history');
      const request=store.get('state');
      let result:{history:DictationHistory;accepted:boolean};
      let failure='Saved history could not be updated. Retry Delete or Clear history.';
      transaction.onabort=()=>reject(new Error(failure));
      transaction.onerror=()=>reject(new Error(failure));
      transaction.oncomplete=()=>resolve(result);
      request.onsuccess=()=>{
        try {
          let history:DictationHistory;
          try{history=validate(request.result);}
          catch{
            if(action.type!=='clear' && !(action.type==='remember' && !action.value))throw new Error('Saved history could not be loaded. Clear history to remove its stored copy.');
            history=empty();
          }
          let accepted=true;
          if(action.type==='remember'){
            if(action.value && action.epoch!==history.epoch)accepted=false;
            else history={version:1,remember:action.value,epoch:crypto.randomUUID(),entries:action.value?boundDictationHistory([...action.entries,...history.entries.filter(item=>!action.entries.some(entry=>entry.id===item.id))],true):[]};
          }else if(action.type==='add'){
            if(!history.remember || action.epoch!==history.epoch || action.isCurrent?.()===false)accepted=false;
            else {
              validate({version:1,remember:true,epoch:history.epoch,entries:[action.entry]});
              history={...history,entries:boundDictationHistory([action.entry,...history.entries],true)};
              accepted=history.entries.some(entry=>entry.id===action.entry.id);
            }
          }else if(action.type==='clear' || action.type==='remove'){
            history={...history,epoch:crypto.randomUUID(),remember:action.disable?false:history.remember,entries:action.disable || action.type==='clear'?[]:history.entries.filter(entry=>entry.id!==action.id)};
          }else history={...history,entries:boundDictationHistory(history.entries,true)};
          if(accepted && (action.type!=='read' || (request.result && history.entries.length!==request.result.entries.length))){validate(history);store.put(history,'state');}
          result={history,accepted};
        }catch(error){failure=error instanceof Error?error.message:failure;transaction.abort();}
      };
    });
  }finally{db.close();}
}

export function useDictationHistory() {
  const [entries,setEntries]=useState<DictationEntry[]>([]);
  const [remember,setRememberState]=useState(false);
  const [ready,setReady]=useState(false);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const current=useRef<DictationEntry[]>([]);
  const saved=useRef(empty());
  const revision=useRef(0);
  const mounted=useRef(true);
  const running=useRef(false);
  const erasePending=useRef(false);
  const channel=useRef<BroadcastChannel|undefined>(undefined);
  function update(next:DictationEntry[]){current.current=next;setEntries(next);}
  function notify(){channel.current?.postMessage('changed');}
  function adopt(history:DictationHistory){
    saved.current=history;
    setRememberState(history.remember && !erasePending.current);
    if(history.remember && !erasePending.current)update(history.entries);
  }
  async function refresh(){
    const version=revision.current;
    try{
      const {history}=await changeDictationHistory({type:'read'});
      if(!mounted.current || version!==revision.current || running.current)return;
      if(saved.current.epoch!==history.epoch){revision.current++;if(!history.remember && saved.current.remember)update([]);}
      adopt(history);
    }catch{if(mounted.current && version===revision.current)setError('Saved dictation history could not be loaded. Clear history to remove its stored copy.');}
    finally{if(mounted.current)setReady(true);}
  }
  async function setRemember(value:boolean){
    if(running.current)return;
    revision.current++;
    running.current=true;setPending(true);
    if(!value){erasePending.current=true;setRememberState(false);}
    try{
      const {history,accepted}=await changeDictationHistory({type:'remember',value,epoch:saved.current.epoch,entries:current.current});
      if(!mounted.current)return;
      if(!accepted){adopt(history);setError('Saved history changed in another view. Review the current setting before enabling Remember.');return;}
      erasePending.current=false;adopt(history);setError('');notify();
    }catch{if(mounted.current)setError(value?'Could not enable saved history. Current-view history is unchanged.':'Remember is off for this view, but saved history could not be deleted. Retry Delete or Clear history before closing.');}
    finally{running.current=false;if(mounted.current)setPending(false);}
  }
  function capture():HistoryCapture{return {revision:revision.current,epoch:saved.current.epoch,remember:saved.current.remember && !erasePending.current,createdAt:Date.now()};}
  async function add(text:string,captured:HistoryCapture){
    if(!mounted.current || captured.revision!==revision.current || !text.trim())return;
    if(!validText(text)){setError('This text cannot be kept in dictation history. Your draft is unchanged.');return;}
    const entry={id:crypto.randomUUID(),text,createdAt:captured.createdAt};
    const next=boundDictationHistory([entry,...current.current],captured.remember);
    if(!next.some(item=>item.id===entry.id)){setError('This dictation exceeds the history storage limit. Your draft is unchanged.');return;}
    if(!captured.remember){update(next);return;}
    try{
      const {history,accepted}=await changeDictationHistory({type:'add',epoch:captured.epoch,entry,isCurrent:()=>mounted.current && captured.revision===revision.current});
      if(!mounted.current || captured.revision!==revision.current)return;
      if(!accepted){revision.current++;saved.current=history;setRememberState(history.remember);update(history.entries);return;}
      adopt(history);setError('');notify();
    }catch{if(mounted.current && captured.revision===revision.current){update(next);setError('This dictation could not be saved on the device. It is available only in this view.');}}
  }
  async function destroy(id?:string){
    if(running.current)return;
    revision.current++;
    running.current=true;setPending(true);
    const next=id?current.current.filter(entry=>entry.id!==id):[];
    try{
      const {history}=await changeDictationHistory({type:id?'remove':'clear',id,disable:erasePending.current});
      if(!mounted.current)return;
      erasePending.current=false;adopt(history);if(!history.remember)update(next);setError('');notify();
    }catch{if(mounted.current){if(!saved.current.remember && !erasePending.current)update(next);setError('Saved history could not be deleted. Retry Delete or Clear history to remove its stored copy.');}}
    finally{running.current=false;if(mounted.current)setPending(false);}
  }
  useEffect(()=>{
    mounted.current=true;
    // Notifications are optional; transactions enforce the stale-write boundary.
    try{
      if(typeof BroadcastChannel!=='undefined'){
        channel.current=new BroadcastChannel(VOICE_HISTORY_DATABASE);
        channel.current.onmessage=()=>{void refresh();};
      }
    }catch{channel.current=undefined;}
    void refresh();
    const timer=setInterval(()=>{void refresh();},60000);
    const visible=()=>{if(document.visibilityState==='visible')void refresh();};
    document.addEventListener('visibilitychange',visible);
    return()=>{mounted.current=false;revision.current++;clearInterval(timer);channel.current?.close();channel.current=undefined;document.removeEventListener('visibilitychange',visible);};
  },[]);
  return {entries,remember,ready,pending,error,capture,add,setRemember,invalidate:()=>{revision.current++;},remove:(id:string)=>destroy(id),clear:()=>destroy()};
}
