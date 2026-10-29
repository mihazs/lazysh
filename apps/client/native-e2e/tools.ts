import {realpath,stat} from 'node:fs/promises';
import {basename} from 'node:path';

export async function executable(path:string,label:string,expected:string) {
  if(!path.startsWith('/'))throw new Error(`Use an absolute path for native GUI ${label}`);
  const name=await realpath(path).catch(()=>{throw new Error(`Missing native GUI dependency: ${label}`);});
  const metadata=await stat(name);
  if(basename(name)!==expected||!metadata.isFile()||!(metadata.mode&0o111)||(metadata.mode&0o6022)||![0,process.getuid!()].includes(metadata.uid))throw new Error(`Untrusted native GUI executable: ${label}`);
  return name;
}
