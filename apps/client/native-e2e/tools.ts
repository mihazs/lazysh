import {realpath,stat} from 'node:fs/promises';
import {basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export async function executable(path:string,label:string,expected:string) {
  if(!path.startsWith('/'))throw new Error(`Use an absolute path for native GUI ${label}`);
  const name=await realpath(path).catch(()=>{throw new Error(`Missing native GUI dependency: ${label}`);});
  const metadata=await stat(name);
  if(basename(name)!==expected||!metadata.isFile()||!(metadata.mode&0o111)||(metadata.mode&0o6022)||![0,process.getuid!()].includes(metadata.uid))throw new Error(`Untrusted native GUI executable: ${label}`);
  return name;
}

/** Poll `probe` until it returns a value; a throw from it ends the wait at once. */
export async function until<T>(stage:string,probe:()=>Promise<T|undefined>,milliseconds=30_000):Promise<T> {
  const deadline=performance.now()+milliseconds;
  for(;;) {
    const value=await probe();
    if(value!==undefined)return value;
    if(performance.now()>=deadline)throw new Error(`Owned native GUI deadline: ${stage}`);
    await delay(25);
  }
}
