import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {OwnedProcess} from './androidSsh';

export const QR_FRAME_LIMIT=192*1024;
export type QrFrameExport=(program:string,args:string[],destination:string,milliseconds:number)=>Promise<void>;
export function qrFrameRelativePath(nonce:string){
  if(!/^[a-f0-9]{32}$/.test(nonce))throw new Error('Invalid owned QR frame nonce');
  return `cache/lazysh-qr-frame-${nonce}.png`;
}
export function validateQrFrame(bytes:Buffer){
  if(bytes.length<24||bytes.length>QR_FRAME_LIMIT||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')throw new Error('Invalid owned QR frame');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(width<1||height<1||width>500||height>500)throw new Error('Invalid owned QR frame');
  return bytes;
}
/** Binary capture belongs only to this diagnostic; the shared text-log cap stays 16 KiB. */
export async function readQrFrame(program:string,args:string[],milliseconds=3_000){
  if(!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>3_000)throw new Error('Invalid owned QR export wait');
  const child=new OwnedProcess(program,args),chunks:Buffer[]=[];
  let length=0,rejectLimit!:(error:Error)=>void;
  const oversized=new Promise<never>((_resolve,reject)=>{rejectLimit=reject;});
  const receive=(data:Buffer)=>{
    length+=data.length;
    if(length>QR_FRAME_LIMIT){rejectLimit(new Error('Owned QR frame exceeds byte limit'));return;}
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
  if(primary)throw primary;
  return validateQrFrame(Buffer.concat(chunks,length));
}
export const exportQrFrame:QrFrameExport=async(program,args,destination,milliseconds)=>{
  const bytes=await readQrFrame(program,args,milliseconds);
  await mkdir(dirname(destination),{recursive:true});
  await writeFile(destination,bytes,{flag:'wx',mode:0o600});
};
