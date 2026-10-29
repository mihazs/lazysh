import {constants} from 'node:fs';
import {open,readlink,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';

const REVIEWED_QR_SHA256='d3488beef1c4d76d5910c17ff6a67165d3392079533480d4927648d63780f681';
export type QrOwnership={check:()=>Promise<void>};
export type QrOwnershipFiles={read:(path:string,limit:number)=>Promise<Buffer>;uid:(path:string)=>Promise<number>;real:(path:string)=>Promise<string>;link:(path:string)=>Promise<string>};
export async function readQrMetadata(path:string,limit:number){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    if(!(await file.stat()).isFile())throw new Error('Not a regular fixture file');
    const bytes=Buffer.alloc(limit+1);
    let length=0;
    while(length<bytes.length){
      const {bytesRead}=await file.read(bytes,length,bytes.length-length,length);
      if(bytesRead===0)break;
      length+=bytesRead;
    }
    if(length>limit)throw new Error('Fixture metadata limit');
    return bytes.subarray(0,length);
  }finally{await file.close();}
}
const files:QrOwnershipFiles={
  read:readQrMetadata,
  async uid(path){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{return (await file.stat()).uid;}finally{await file.close();}},
  real:realpath,link:readlink,
};

const ownershipMessage='Owned QR imagefile camera attestation failed';
const ownershipChecks=['environment','pid-file-owner','pid-file','camera-path','emulator-binaries','process-owner','process-identity','pid-file-stability','process-continuity','executable','argv-framing','port','avd','camera-back','camera-front','pid-argument','option-aliases','qemu-tail','camera-digest'] as const;
export function qrOwnershipFailure(error:unknown){
  try{
    if(!(error instanceof Error)||error.message!==ownershipMessage)return;
    const cause=error.cause;return typeof cause==='string'&&ownershipChecks.some(check=>check===cause)?cause:undefined;
  }catch{return undefined;}
}

/** Read only the explicitly nominated QEMU PID: never search processes or print argv. */
export async function attestQrCamera(env:NodeJS.ProcessEnv,root:string,io=files,uid=process.getuid?.()):Promise<QrOwnership>{
  let check:typeof ownershipChecks[number]='environment';
  const error=()=>new Error(ownershipMessage,{cause:check});
  try{
    const pidFile=env.LAZYSH_ANDROID_QR_EMULATOR_PID_FILE,sdk=env.ANDROID_HOME;
    if(uid===undefined||!pidFile||!sdk||!isAbsolute(pidFile)||!isAbsolute(sdk)||!/^emulator-[0-9]{4,5}$/.test(env.ANDROID_SERIAL??''))throw error();
    check='pid-file-owner';
    if(await io.uid(pidFile)!==uid)throw error();
    check='pid-file';
    const raw=(await io.read(pidFile,32)).toString('utf8').trim();
    if(!/^[1-9][0-9]{0,8}$/.test(raw))throw error();
    const proc=`/proc/${raw}`;check='camera-path';
    const asset=await io.real(join(root,'apps/client/src-tauri/fixtures/theme-qr-camera-feed.png'));
    check='emulator-binaries';
    const binaries=(await Promise.all(['qemu-system-x86_64','qemu-system-x86_64-headless'].map(name=>io.real(join(sdk,'emulator/qemu/linux-x86_64',name)).catch(()=>undefined)))).filter((value):value is string=>value!==undefined);
    if(!binaries.length)throw error();
    async function identity(){
      check='process-owner';
      if(await io.uid(`${proc}/stat`)!==uid)throw error();
      check='process-identity';
      const stat=(await io.read(`${proc}/stat`,4096)).toString('utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/);
      if(stat.slice(0,stat.indexOf(' '))!==raw||['Z','X'].includes(fields[0])||!/^\d+$/.test(fields[19]??''))throw error();
      return fields[19];
    }
    const original=await identity();
    async function verify(){
      check='pid-file-stability';
      if((await io.read(pidFile,32)).toString('utf8').trim()!==raw||await io.uid(pidFile)!==uid)throw error();
      const current=await identity();check='process-continuity';if(current!==original)throw error();
      check='executable';
      if(!binaries.includes(await io.link(`${proc}/exe`)))throw error();
      check='argv-framing';
      const bytes=await io.read(`${proc}/cmdline`,64*1024);
      if(bytes.at(-1)!==0)throw error();
      const args=bytes.toString('utf8').split('\0').slice(0,-1);
      function one(flag:string,value:string){const positions=args.flatMap((arg,index)=>arg===flag?[index]:[]);if(positions.length!==1||args[positions[0]+1]!==value)throw error();}
      check='port';one('-port',env.ANDROID_SERIAL!.slice('emulator-'.length));check='avd';one('-avd','lazysh-runtime-api36');
      check='camera-back';one('-camera-back',`imagefile:${asset}`);check='camera-front';one('-camera-front','none');check='pid-argument';one('-pidfile',pidFile);
      const admitted=new Set(['-port','-avd','-camera-back','-camera-front']);
      check='option-aliases';
      if(args.some(arg=>/^--?(?:camera[-_](?:front|back)|ports?|android-ports|avd)(?:=|$)/.test(arg)&&!admitted.has(arg)))throw error();
      check='qemu-tail';
      if(args.filter(arg=>arg==='-qemu').length!==1||args.at(-3)!=='-qemu'||args.at(-2)!=='-pidfile'||args.at(-1)!==pidFile||!args.includes('-no-window')||!args.includes('-no-snapshot'))throw error();
      check='camera-digest';
      if(createHash('sha256').update(await io.read(asset,192*1024)).digest('hex')!==REVIEWED_QR_SHA256)throw error();
      const final=await identity();check='process-continuity';if(final!==original)throw error();
    }
    await verify();
    return {async check(){try{await verify();}catch{throw error();}}};
  }catch{throw error();}
}
