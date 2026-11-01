import {lstat,open,realpath} from 'node:fs/promises';
import {basename,join,relative,resolve,sep} from 'node:path';

export const windowsStandardProgressStages=['UNKNOWN','PREPARED','WORKER_ENTERED','CONFIG_READ','WORKER_STARTED','IMPORTS_READY','VALIDATION_ENTERED','GUI_ENTERED','GUI_CLIENT_WAIT','GUI_CLEANUP','GUI_RETURNED','VALIDATION_RETURNED','RESULT_WRITTEN'] as const;
const diagnosticName='work/standard-progress.json';
export function insideStandardRoot(path:string,root:string){const name=relative(resolve(root),resolve(path));return name===''||(!name.startsWith('..'+sep)&&name!=='..'&&!name.startsWith(sep)&&!name.includes(':'));}
export function standardDiagnosticStage(value:unknown):string {
  return typeof value==='string'&&(windowsStandardProgressStages as readonly string[]).includes(value)?value:'UNKNOWN';
}
export function standardDiagnosticIdentity(fixture:unknown,source:unknown,binary:unknown){
  return typeof fixture==='string'&&/^lazysh-standard-[0-9]{1,20}-[0-9]{1,20}$/.test(fixture)&&typeof source==='string'&&/^[a-f0-9]{40}$/.test(source)&&typeof binary==='string'&&/^[a-f0-9]{64}$/.test(binary)?{fixture,source,binary}:undefined;
}
async function standardDiagnostic(root:string,source:string,binary:string,next?:string):Promise<string>{
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
    const fixture=basename(root);
    if(!standardDiagnosticIdentity(fixture,source,binary))return 'UNKNOWN';
    const path=join(root,diagnosticName),before=await lstat(path);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>512||!insideStandardRoot(await realpath(path),root))return 'UNKNOWN';
    file=await open(path,next===undefined?'r':'r+');
    const retained=await file.stat();
    if(!retained.isFile()||retained.nlink!==1||retained.dev!==before.dev||retained.ino!==before.ino||retained.size!==before.size)return 'UNKNOWN';
    const bytes=Buffer.alloc(513);let size=0;
    while(size<bytes.length){const read=await file.read(bytes,size,bytes.length-size,size);if(!read.bytesRead)break;size+=read.bytesRead;}
    const after=await file.stat(),leaf=await lstat(path);
    if(size>512||after.size!==size||after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||!leaf.isFile()||after.nlink!==1||leaf.nlink!==1||leaf.size!==after.size||leaf.isSymbolicLink()||leaf.dev!==after.dev||leaf.ino!==after.ino)return 'UNKNOWN';
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='binary,fixture,source,stage'||value.fixture!==fixture||value.source!==source||value.binary!==binary||standardDiagnosticStage(value.stage)!==value.stage)return 'UNKNOWN';
    if(next!==undefined){
      if(standardDiagnosticStage(next)!==next)return 'UNKNOWN';
      await file.truncate(0);await file.writeFile(JSON.stringify({...value,stage:next}));
    }
    return next??value.stage;
  }catch{return 'UNKNOWN';}finally{await file?.close().catch(()=>{});}
}
export async function readStandardDiagnostic(root:string,source:string,binary:string){return standardDiagnostic(root,source,binary);}
export async function publishStandardProgress(root:string,source:string,binary:string,stage:string,fixture?:string){if(fixture!==undefined&&fixture!==basename(root))return;await standardDiagnostic(root,source,binary,stage);}
