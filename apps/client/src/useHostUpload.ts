import {useEffect,useRef,useState} from 'react';
import {captureAccess} from './access';
import type {api as nativeApi} from './bridge';
import {ATTACHMENT_LIMIT,checkDestination} from './attachment';
import {LocalUiError} from './i18n/localError';

type Api=Pick<typeof nativeApi,'reserveUpload'|'cancelUpload'|'uploadFile'>;
type Prepared={path:string;bytes:Uint8Array};
type Operation={abandoned:boolean;receipt?:string;cancel?:Promise<void>;settled?:boolean};
/** One caller-owned upload. A late reserve acknowledgement can only be cancelled. */
export function useHostUpload(api:Api,sessionId:string,onError:(error:unknown)=>void){
  const access=useRef(captureAccess()).current;
  const alive=useRef(true);
  const operation=useRef<Operation|null>(null);
  const [busy,setBusy]=useState(false);
  const [cancelling,setCancelling]=useState(false);
  const [cancelled,setCancelled]=useState(false);
  const mounted=()=>alive.current&&access.current();
  function sendCancel(job:Operation){
    if(!job.receipt)return Promise.resolve();
    return job.cancel??=(api.cancelUpload(sessionId,job.receipt).then(()=>{}).catch(error=>{
      if(mounted()&&operation.current===job)onError(error);
    }));
  }
  function cancel(){
    const job=operation.current;
    if(!job)return;
    job.abandoned=true;
    if(mounted()){setCancelling(true);setCancelled(true);}
    void sendCancel(job);
  }
  useEffect(()=>{
    alive.current=true;
    return ()=>{alive.current=false;const job=operation.current;if(job){job.abandoned=true;void sendCancel(job);}};
  },[sessionId]);
  async function start(prepare:()=>Promise<Prepared>,complete:(path:string,uploadId:string)=>void){
    if(operation.current||!mounted())return;
    const job:Operation={abandoned:false};operation.current=job;
    setBusy(true);setCancelling(false);setCancelled(false);
    const current=()=>mounted()&&!job.abandoned&&operation.current===job;
    try{
      const prepared=await prepare();
      if(!current())return;
      checkDestination(prepared.path);
      if(prepared.bytes.length>ATTACHMENT_LIMIT)throw new LocalUiError('attachmentEditedLimit');
      const reserved=await api.reserveUpload(sessionId,prepared.bytes.length);
      job.receipt=reserved.uploadId;
      if(!current()){await sendCancel(job);return;}
      const uploaded=await api.uploadFile(sessionId,prepared.path,Array.from(prepared.bytes),job.receipt);
      job.settled=true;
      if(current())complete(uploaded.path,job.receipt);
    }catch(error){if(current())onError(error);}
    finally{
      // Keep the original operation responsible for its pending cancellation,
      // even when the transfer response arrives first. Never issue a second RPC.
      if(job.cancel)await job.cancel;
      else if(job.receipt&&!job.settled)await sendCancel(job);
      if(operation.current===job){operation.current=null;if(mounted()){setBusy(false);setCancelling(false);}}
    }
  }
  return {busy,cancelling,cancelled,start,cancel,active:()=>operation.current!==null};
}
