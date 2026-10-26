import {useEffect,useRef,useState} from 'react';
import {captureAccess} from './access';
import type {api as nativeApi} from './bridge';
type Api=Pick<typeof nativeApi,'hostClipboardCopy'|'cancelUpload'>;
type Target={uploadId:string};
type Request={target:Target;abandoned:boolean;cancel?:Promise<void>};
/** Explicit copy only; native receipt owns the actual original path and session. */
export function useHostClipboard(api:Api,sessionId:string,onError:(error:unknown)=>void,onNotice:(kind:'copied'|'cancelled')=>void){
  const original=useRef({sessionId,access:captureAccess()}).current;
  const latest=useRef(sessionId);latest.current=sessionId;
  const alive=useRef(true);
  const target=useRef<Target|null>(null);
  const request=useRef<Request|null>(null);
  const [ready,setReady]=useState(false);
  const [busy,setBusy]=useState(false);
  const current=()=>alive.current&&original.access.current()&&latest.current===original.sessionId;
  function clear(){
    const previous=target.current;target.current=null;
    if(current())setReady(false);
    if(!previous)return;
    const pending=request.current;
    if(pending?.target===previous){
      pending.abandoned=true;
      if(current())onNotice('cancelled');
      pending.cancel??=api.cancelUpload(original.sessionId,previous.uploadId).then(()=>{}).catch(error=>{if(current()&&request.current===pending)onError(error);});
    }else void api.cancelUpload(original.sessionId,previous.uploadId).catch(()=>{});
  }
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;clear();};},[sessionId]);
  function completed(uploadId:string){
    if(!current())return;
    target.current={uploadId};setReady(true);
  }
  async function copy(){
    const selected=target.current;
    if(!current()||!selected||request.current)return;
    const pending:Request={target:selected,abandoned:false};request.current=pending;setBusy(true);
    const valid=()=>current()&&!pending.abandoned&&target.current===selected;
    try{await api.hostClipboardCopy(original.sessionId,selected.uploadId);if(valid())onNotice('copied');}
    catch(error){if(valid())onError(error);}
    finally{
      if(pending.cancel)await pending.cancel;
      if(request.current===pending){request.current=null;if(current())setBusy(false);}
    }
  }
  return {ready:ready&&current(),busy,completed,clear,copy,active:()=>request.current!==null};
}
