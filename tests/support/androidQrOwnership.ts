import {constants} from 'node:fs';
import {open,readlink,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';

const REVIEWED_QR_SHA256='ccb83c409118e384e7e3fbee856a4c282984688a582ef7372fb7eb9980f0e778';
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

/** Read only the explicitly nominated QEMU PID: never search processes or print argv. */
export async function attestQrCamera(env:NodeJS.ProcessEnv,root:string,io=files,uid=process.getuid?.()):Promise<QrOwnership>{
  const error=()=>new Error('Owned QR imagefile camera attestation failed');
  try{
    const pidFile=env.LAZYSH_ANDROID_QR_EMULATOR_PID_FILE,sdk=env.ANDROID_HOME;
    if(uid===undefined||!pidFile||!sdk||!isAbsolute(pidFile)||!isAbsolute(sdk)||!/^emulator-[0-9]{4,5}$/.test(env.ANDROID_SERIAL??''))throw error();
    if(await io.uid(pidFile)!==uid)throw error();
    const raw=(await io.read(pidFile,32)).toString('utf8').trim();
    if(!/^[1-9][0-9]{0,8}$/.test(raw))throw error();
    const proc=`/proc/${raw}`,asset=await io.real(join(root,'apps/client/src-tauri/fixtures/theme-qr.png'));
    const binaries=(await Promise.all(['qemu-system-x86_64','qemu-system-x86_64-headless'].map(name=>io.real(join(sdk,'emulator/qemu/linux-x86_64',name)).catch(()=>undefined)))).filter((value):value is string=>value!==undefined);
    if(!binaries.length)throw error();
    async function identity(){
      if(await io.uid(`${proc}/stat`)!==uid)throw error();
      const stat=(await io.read(`${proc}/stat`,4096)).toString('utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/);
      if(stat.slice(0,stat.indexOf(' '))!==raw||['Z','X'].includes(fields[0])||!/^\d+$/.test(fields[19]??''))throw error();
      return fields[19];
    }
    const original=await identity();
    async function check(){
      if((await io.read(pidFile,32)).toString('utf8').trim()!==raw||await io.uid(pidFile)!==uid||await identity()!==original)throw error();
      if(!binaries.includes(await io.link(`${proc}/exe`)))throw error();
      const bytes=await io.read(`${proc}/cmdline`,64*1024);
      if(bytes.at(-1)!==0)throw error();
      const args=bytes.toString('utf8').split('\0').slice(0,-1);
      function one(flag:string,value:string){const positions=args.flatMap((arg,index)=>arg===flag?[index]:[]);if(positions.length!==1||args[positions[0]+1]!==value)throw error();}
      one('-port',env.ANDROID_SERIAL!.slice('emulator-'.length));one('-avd','lazysh-runtime-api36');
      one('-camera-back',`imagefile:${asset}`);one('-camera-front','none');one('-pidfile',pidFile);
      const admitted=new Set(['-port','-avd','-camera-back','-camera-front']);
      if(args.some(arg=>/^--?(?:camera[-_](?:front|back)|ports?|android-ports|avd)(?:=|$)/.test(arg)&&!admitted.has(arg)))throw error();
      if(args.filter(arg=>arg==='-qemu').length!==1||args.at(-3)!=='-qemu'||args.at(-2)!=='-pidfile'||args.at(-1)!==pidFile||!args.includes('-no-window')||!args.includes('-no-snapshot'))throw error();
      if(createHash('sha256').update(await io.read(asset,192*1024)).digest('hex')!==REVIEWED_QR_SHA256||await identity()!==original)throw error();
    }
    await check();
    return {async check(){try{await check();}catch{throw error();}}};
  }catch{throw error();}
}
