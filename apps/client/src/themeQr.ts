import {invoke,isTauri} from '@tauri-apps/api/core';
import {useEffect,useRef,useState,type RefObject} from 'react';
import {subscribeAccess,useAccessSnapshot,useMountedAccess} from './access';

export const QR_IMAGE_LIMIT=192*1024;
const errors={busy:'themeQrBusy',imageLimit:'themeQrImageLimit',invalidImage:'themeQrInvalidImage',multipleCodes:'themeQrMultiple',invalidPayload:'themeQrInvalidPayload',stopped:'themeQrStopped',cameraUnavailable:'themeQrCameraUnavailable',cameraFailed:'themeQrCameraFailed',encodeFailed:'themeQrEncodeFailed',failed:'themeQrFailed'} as const;
type Failure=keyof typeof errors;
class QrFailure extends Error {constructor(readonly code:Failure){super(code);}}
export const qrErrorKey=(error:Failure)=>errors[error];
export type QrState={phase:'idle'|'permission'|'scanning'|'reading'|'decoding';finishing:boolean;camera?:boolean;error?:Failure;notice?:'cancelled'|'timeout'|'none'};
type Run={intent:number;active:boolean;stream?:MediaStream;video?:HTMLVideoElement;deadline?:ReturnType<typeof setTimeout>;delay?:ReturnType<typeof setTimeout>;wake?:()=>void;publish:(payload:string)=>void};
// Cancellation stops publication immediately; capacity belongs to the actual async pipeline.
let pipeline:Run|null=null;
export function qrFrameSize(width:number,height:number){
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new QrFailure('encodeFailed');
  const scale=Math.min(1,500/width,500/height);
  return {width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
}
export function qrImageBytes(bytes:ArrayBuffer){
  if(bytes.byteLength<1||bytes.byteLength>QR_IMAGE_LIMIT)throw new QrFailure('imageLimit');
  const data=new Uint8Array(bytes);
  const png=[137,80,78,71,13,10,26,10].every((value,index)=>data[index]===value);
  if(!png && !(data[0]===255&&data[1]===216&&data[2]===255))throw new QrFailure('invalidImage');
  return Array.from(data);
}
function failure(error:unknown):Failure {
  if(error instanceof QrFailure)return error.code;
  return typeof error==='string'&&Object.hasOwn(errors,error)?error as Failure:'failed';
}
/** Retain the actual invoke future: ordinary protectedInvoke settles early on revocation. */
export function useThemeQr(intent:RefObject<number>,cancelRef:RefObject<(()=>void)|null>,onDecoded:(payload:string)=>void){
  const {access,mounted}=useMountedAccess();useAccessSnapshot();
  const video=useRef<HTMLVideoElement>(null),active=useRef<Run|null>(null),owned=useRef(false);
  const [state,setState]=useState<QrState>({phase:'idle',finishing:false});
  const current=(run:Run)=>mounted.current&&access.current()&&run.active&&active.current===run&&run.intent===intent.current&&document.visibilityState!=='hidden'&&video.current?.closest<HTMLDetailsElement>('details')?.open!==false;
  function release(run:Run){
    run.active=false;clearTimeout(run.deadline);clearTimeout(run.delay);run.wake?.();run.wake=undefined;
    const stream=run.stream;run.stream=undefined;
    stream?.getTracks().forEach(track=>track.stop());
    if(run.video && run.video.srcObject===stream){run.video.pause();run.video.srcObject=null;}
    if(active.current===run)active.current=null;
  }
  function cancel(notice?:QrState['notice']){
    if(active.current)release(active.current);
    if(mounted.current&&access.current())setState({phase:'idle',finishing:owned.current,notice});
  }
  useEffect(()=>{
    const invalidate=()=>cancel();cancelRef.current=invalidate;
    const hidden=()=>{if(document.visibilityState==='hidden')cancel('cancelled');};
    const leaving=()=>cancel('cancelled');
    const unsubscribe=subscribeAccess(()=>{if(!access.current())cancel();});
    document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',leaving);
    return()=>{if(cancelRef.current===invalidate)cancelRef.current=null;unsubscribe();document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',leaving);if(active.current)release(active.current);};
  },[]);
  function phase(run:Run,value:QrState['phase']){if(current(run))setState({phase:value,finishing:false,camera:!!run.video});}
  async function decode(run:Run,bytes:ArrayBuffer):Promise<string|null|undefined>{
    if(!current(run))return;
    const encoded=qrImageBytes(bytes);phase(run,'decoding');access.assert();
    const payload=await invoke<unknown>('theme_qr_decode',{bytes:encoded},{headers:access.headers});
    if(!current(run))return;
    if(payload===null)return null;
    if(typeof payload!=='string'||/[\uD800-\uDFFF]/u.test(payload)||new TextEncoder().encode(payload).byteLength>16384)throw new QrFailure('invalidPayload');
    return payload;
  }
  async function waitFrame(run:Run){await new Promise<void>(resolve=>{run.wake=resolve;run.delay=setTimeout(()=>{run.wake=undefined;resolve();},250);});}
  async function camera(run:Run){
    if(!navigator.mediaDevices?.getUserMedia)throw new QrFailure('cameraUnavailable');
    let stream:MediaStream;
    try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});}catch{throw new QrFailure('cameraFailed');}
    if(!current(run)){stream.getTracks().forEach(track=>track.stop());return;}
    run.stream=stream;run.video=video.current??undefined;
    if(!run.video)throw new QrFailure('cameraFailed');
    run.video.srcObject=stream;
    try{await run.video.play();}catch{throw new QrFailure('cameraFailed');}
    while(current(run)){
      phase(run,'scanning');
      if(run.video.readyState<2||!run.video.videoWidth||!run.video.videoHeight){await waitFrame(run);continue;}
      const size=qrFrameSize(run.video.videoWidth,run.video.videoHeight),canvas=document.createElement('canvas');
      canvas.width=size.width;canvas.height=size.height;
      const context=canvas.getContext('2d');if(!context)throw new QrFailure('encodeFailed');
      context.drawImage(run.video,0,0,size.width,size.height);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new QrFailure('encodeFailed')),'image/jpeg',.85));
      if(!current(run))return;
      if(blob.size<1||blob.size>QR_IMAGE_LIMIT)throw new QrFailure('imageLimit');
      const bytes=await blob.arrayBuffer();const payload=await decode(run,bytes);
      if(payload===undefined)return;
      if(payload!==null){complete(run,payload);return;}
      await waitFrame(run);
    }
  }
  function complete(run:Run,payload:string){
    if(!current(run))return;release(run);setState({phase:'idle',finishing:true});run.publish(payload);
  }
  function start(file?:File){
    if(!isTauri()||owned.current||!mounted.current||!access.current()||document.visibilityState==='hidden')return;
    if(pipeline){setState({phase:'idle',finishing:false,error:'busy'});return;}
    const run:Run={intent:intent.current,active:true,publish:onDecoded};pipeline=run;active.current=run;owned.current=true;
    setState({phase:file?'reading':'permission',finishing:false,camera:!file});
    run.deadline=setTimeout(()=>{if(active.current===run){if(current(run))cancel('timeout');else release(run);}},30_000);
    void (async()=>{
      try{
        if(file){
          if(file.size<1||file.size>QR_IMAGE_LIMIT)throw new QrFailure('imageLimit');
          const bytes=await file.arrayBuffer();const payload=await decode(run,bytes);
          if(payload===undefined)return;
          if(payload===null){if(current(run)){release(run);setState({phase:'idle',finishing:true,notice:'none'});}}
          else complete(run,payload);
        }else await camera(run);
      }catch(error){if(current(run)){release(run);setState({phase:'idle',finishing:true,error:failure(error)});}}
      finally{
        release(run);if(pipeline===run)pipeline=null;owned.current=false;
        // Only availability is released here; stale work never publishes payloads or errors.
        if(mounted.current&&access.current())setState(previous=>({...previous,phase:'idle',finishing:false}));
      }
    })();
  }
  return {state,video,startFile:(file:File)=>start(file),startCamera:()=>start(),cancel:()=>cancel('cancelled'),current:()=>access.current()};
}
