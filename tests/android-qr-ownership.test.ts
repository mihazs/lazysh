import {expect,test} from 'bun:test';
import {attestQrCamera,readQrMetadata,type QrOwnershipFiles} from './support/androidQrOwnership';
import {constants} from 'node:fs';
import {mkdtemp,open,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const image=Buffer.from(await Bun.file(new URL('../apps/client/src-tauri/fixtures/theme-qr.png',import.meta.url)).arrayBuffer());
const asset='/owned/apps/client/src-tauri/fixtures/theme-qr.png';
const binary='/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64';
const env={ANDROID_SERIAL:'emulator-5580',ANDROID_HOME:'/sdk',LAZYSH_ANDROID_QR_EMULATOR_PID_FILE:'/owned.pid'};
function fixture(){
  const state={pid:'123\n',uid:1000,start:'42',status:'S',exe:binary,image,
    args:[binary,'-port','5580','-avd','lazysh-runtime-api36','-no-window','-no-snapshot','-camera-back',`imagefile:${asset}`,'-camera-front','none','-qemu','-pidfile','/owned.pid']};
  const requests:string[]=[];
  const io:QrOwnershipFiles={
    async read(path,limit){
      requests.push(path);
      let value:Buffer;
      if(path==='/owned.pid')value=Buffer.from(state.pid);
      else if(path==='/proc/123/stat')value=Buffer.from(`123 (owned qemu) ${[state.status,'1',...Array(17).fill('0'),state.start].join(' ')}`);
      else if(path==='/proc/123/cmdline')value=Buffer.from(state.args.join('\0')+'\0');
      else if(path===asset)value=state.image;
      else throw new Error('Unexpected path');
      if(value.length>limit)throw new Error('Bounded fixture read');
      return value;
    },
    async uid(path){requests.push(path);return state.uid;},
    async real(path){requests.push(path);return path;},
    async link(path){requests.push(path);return state.exe;},
  };
  return {state,requests,io};
}
test('exact reviewed launch is pinned without scanning processes or exposing argv',async()=>{
  const f=fixture(),pin=await attestQrCamera(env,'/owned',f.io,1000);
  await pin.check();
  expect(f.requests.every(path=>path==='/owned.pid'||path===asset||path.startsWith('/proc/123/')||path.startsWith('/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64'))).toBe(true);
});
test.each([
  ['rear webcam',(f:ReturnType<typeof fixture>)=>{f.state.args[8]='webcam0';}],
  ['front webcam',(f:ReturnType<typeof fixture>)=>{f.state.args[10]='webcam1';}],
  ['different image',(f:ReturnType<typeof fixture>)=>{f.state.args[8]='imagefile:/private/unreviewed.png';}],
  ['overridden camera',(f:ReturnType<typeof fixture>)=>{f.state.args.splice(11,0,'-camera-back','webcam0');}],
  ['alias override',(f:ReturnType<typeof fixture>)=>{f.state.args.splice(11,0,'-camera_front','webcam0');}],
  ['port override',(f:ReturnType<typeof fixture>)=>{f.state.args.splice(11,0,'-port','5582');}],
  ['other serial',(f:ReturnType<typeof fixture>)=>{f.state.args[2]='5582';}],
  ['other exe',(f:ReturnType<typeof fixture>)=>{f.state.exe='/private/other-program';}],
  ['other user',(f:ReturnType<typeof fixture>)=>{f.state.uid=1001;}],
  ['dead process',(f:ReturnType<typeof fixture>)=>{f.state.status='Z';}],
  ['malformed PID',(f:ReturnType<typeof fixture>)=>{f.state.pid='../private';}],
  ['changed image bytes',(f:ReturnType<typeof fixture>)=>{f.state.image=Buffer.from('unreviewed');}],
] as const)('rejects %s with fixed nonsecret error',async(_name,change)=>{
  const f=fixture();change(f);
  await expect(attestQrCamera(env,'/owned',f.io,1000)).rejects.toThrow('Owned QR imagefile camera attestation failed');
});
test('reused PID and changed launch cannot inherit an earlier attestation',async()=>{
  const f=fixture(),pin=await attestQrCamera(env,'/owned',f.io,1000);
  f.state.start='43';await expect(pin.check()).rejects.toThrow('Owned QR imagefile camera attestation failed');
  f.state.start='42';f.state.args[8]='webcam0';await expect(pin.check()).rejects.toThrow('Owned QR imagefile camera attestation failed');
});
test('missing PID nomination fails before any fixture reads',async()=>{
  const f=fixture();
  await expect(attestQrCamera({...env,LAZYSH_ANDROID_QR_EMULATOR_PID_FILE:undefined},'/owned',f.io,1000)).rejects.toThrow('Owned QR imagefile camera attestation failed');
  expect(f.requests).toEqual([]);
});
test('one installed known QEMU candidate suffices; missing candidates never admit another binary',async()=>{
  const f=fixture();
  f.io.real=async path=>{if(path.endsWith('-headless'))throw new Error('Absent optional binary');return path;};
  await expect(attestQrCamera(env,'/owned',f.io,1000)).resolves.toBeDefined();
  f.state.exe='/sdk/emulator/qemu/linux-x86_64/unknown-qemu';
  await expect(attestQrCamera(env,'/owned',f.io,1000)).rejects.toThrow('Owned QR imagefile camera attestation failed');
});
test.skipIf(process.platform!=='linux')('native metadata reads enforce EOF bounds, reject symlinks and never block on an owned FIFO',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-qr-metadata-'));
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const regular=join(directory,'regular'),link=join(directory,'link'),fifo=join(directory,'fifo');
    await writeFile(regular,'12345');
    expect((await readQrMetadata(regular,5)).toString()).toBe('12345');
    await expect(readQrMetadata(regular,4)).rejects.toThrow('Fixture metadata limit');
    await symlink(regular,link);await expect(readQrMetadata(link,5)).rejects.toBeDefined();
    expect(Bun.spawnSync(['mkfifo',fifo]).exitCode).toBe(0);
    const rejected=readQrMetadata(fifo,32).then(()=>false,()=>true);
    let expired=false;
    try {
      expect(await Promise.race([rejected,new Promise<boolean>(resolve=>{timer=setTimeout(()=>{expired=true;resolve(false);},1000);})])).toBe(true);
      expect(expired).toBe(false);
    }finally{
      if(timer)clearTimeout(timer);
      // A mutant blocking O_RDONLY still gets released; this fixture cannot leave a stuck reader.
      const writer=await open(fifo,constants.O_RDWR|constants.O_NONBLOCK);
      try{await rejected;}finally{await writer.close();}
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
