import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {OwnedProcess} from './androidSsh';

export const QR_FRAME_LIMIT=192*1024;
export type QrFrameFailure={
  phase:'spawn'|'process'|'bytes'|'header'|'dimensions'|'directory'|'write';
  reason:'unavailable'|'failed'|'limit'|'invalid'|'missing'|'denied'|'exists'|'space'|'readonly'|'io'|'other';
  exitCode:number|null;signal:'SIGTERM'|'SIGKILL'|'SIGINT'|'OTHER'|null;byteCount:number;truncated:boolean;
};
export type QrFrameReporter=(failure:Readonly<QrFrameFailure>)=>void;
export type QrFrameExport=(program:string,args:string[],destination:string,milliseconds:number,report?:QrFrameReporter)=>Promise<void>;
const failureTrace=():QrFrameFailure=>({phase:'spawn',reason:'failed',exitCode:null,signal:null,byteCount:0,truncated:false});
export function qrFrameFailureMetadata(value:unknown):QrFrameFailure|undefined{
  try{
    if(!value||typeof value!=='object')return;
    const {phase,reason,exitCode,signal,byteCount,truncated}=value as QrFrameFailure;
    if(!['spawn','process','bytes','header','dimensions','directory','write'].includes(phase)||
      !['unavailable','failed','limit','invalid','missing','denied','exists','space','readonly','io','other'].includes(reason)||
      !(exitCode===null||(Number.isInteger(exitCode)&&exitCode>=0&&exitCode<=255))||
      !(signal===null||['SIGTERM','SIGKILL','SIGINT','OTHER'].includes(signal))||
      !Number.isInteger(byteCount)||byteCount<0||byteCount>QR_FRAME_LIMIT+1||typeof truncated!=='boolean')return;
    return {phase,reason,exitCode,signal,byteCount,truncated};
  }catch{return;}
}
function reportFailure(report:QrFrameReporter|undefined,trace:QrFrameFailure,error:unknown){
  // Even unusual error.code getters and diagnostic callbacks cannot replace the original failure.
  if(trace.phase==='directory'||trace.phase==='write'){
    let code:unknown;
    try{code=(error as NodeJS.ErrnoException)?.code;}catch{/* No exception data is retained. */}
    const reasons:Record<string,QrFrameFailure['reason']>={ENOENT:'missing',EACCES:'denied',EPERM:'denied',EEXIST:'exists',ENOSPC:'space',EROFS:'readonly',EIO:'io'};
    trace.reason=typeof code==='string'&&Object.hasOwn(reasons,code)?reasons[code]:'other';
  }
  try{report?.({...trace});}catch{/* Optional metadata never changes the original operation result. */}
}
export function qrFrameRelativePath(nonce:string){
  if(!/^[a-f0-9]{32}$/.test(nonce))throw new Error('Invalid owned QR frame nonce');
  return `cache/lazysh-qr-frame-${nonce}.png`;
}
export function validateQrFrame(bytes:Buffer,trace:QrFrameFailure=failureTrace()){
  trace.byteCount=Math.min(bytes.length,QR_FRAME_LIMIT+1);
  trace.phase='bytes';trace.reason='invalid';
  if(bytes.length<24||bytes.length>QR_FRAME_LIMIT){trace.reason='limit';trace.truncated=bytes.length>QR_FRAME_LIMIT;throw new Error('Invalid owned QR frame');}
  trace.phase='header';
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')throw new Error('Invalid owned QR frame');
  trace.phase='dimensions';
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(width<1||height<1||width>500||height>500)throw new Error('Invalid owned QR frame');
  return bytes;
}
/** Binary capture belongs only to this diagnostic; the shared text-log cap stays 16 KiB. */
export async function readQrFrame(program:string,args:string[],milliseconds=3_000,trace:QrFrameFailure=failureTrace()){
  if(!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>3_000)throw new Error('Invalid owned QR export wait');
  trace.phase='spawn';
  const child=new OwnedProcess(program,args),chunks:Buffer[]=[];
  trace.phase='process';
  let length=0,rejectLimit!:(error:Error)=>void;
  const oversized=new Promise<never>((_resolve,reject)=>{rejectLimit=reject;});
  const receive=(data:Buffer)=>{
    length+=data.length;
    trace.byteCount=Math.min(length,QR_FRAME_LIMIT+1);
    if(length>QR_FRAME_LIMIT){trace.phase='bytes';trace.reason='limit';trace.truncated=true;rejectLimit(new Error('Owned QR frame exceeds byte limit'));return;}
    chunks.push(Buffer.from(data));
  };
  child.child.stdout!.on('data',receive);
  let settled=false;
  const finished=child.finish('owned QR binary export',milliseconds).finally(()=>{settled=true;});
  let primary:unknown;
  try {await Promise.race([finished,oversized]);}
  catch(error){primary=error;}
  finally {
    // finish already owns its teardown. Only an early size rejection needs an
    // immediate stop, never a second sequential teardown after finish settles.
    if(!settled)try{await child.stop();}catch(error){primary??=error;}
    await finished.catch(()=>{});
    child.child.stdout!.off('data',receive);
  }
  const code=child.child.exitCode,signal=child.child.signalCode;
  trace.exitCode=Number.isInteger(code)&&code!==null&&code>=0&&code<=255?code:null;
  // This is the observed status after teardown, not attribution of the original failure.
  trace.signal=signal===null?null:signal==='SIGTERM'||signal==='SIGKILL'||signal==='SIGINT'?signal:'OTHER';
  if(primary){
    if(child.child.pid===undefined){trace.phase='spawn';trace.reason='unavailable';}
    throw primary;
  }
  return validateQrFrame(Buffer.concat(chunks,length),trace);
}
export const exportQrFrame:QrFrameExport=async(program,args,destination,milliseconds,report)=>{
  const trace=failureTrace();
  try{
    const bytes=await readQrFrame(program,args,milliseconds,trace);
    trace.phase='directory';trace.reason='failed';
    await mkdir(dirname(destination),{recursive:true});
    trace.phase='write';
    await writeFile(destination,bytes,{flag:'wx',mode:0o600});
  }catch(error){reportFailure(report,trace,error);throw error;}
};
