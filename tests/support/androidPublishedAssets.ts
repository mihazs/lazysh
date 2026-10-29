import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,realpath,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {artifactName,digestFile,validateReceipt} from '../../.changeset/release-artifacts';
import {OwnedProcess} from './ownedProcess';

const repository='https://api.github.com/repos/mihazs/lazysh';
const apkLimit=64*1024*1024,metadataLimit=64*1024,apiLimit=128*1024;
type Flavor='google'|'foss';
export type PublishedApk={apk:string;sha:string;version:string;tag:string;flavor:Flavor;sha256:string;bytes:number;certificateSha256:string};
type Asset={name:string;size:number;digest:string;browser_download_url:string};
export type PublishedAssetIo={fetch:typeof fetch;command:(program:string,args:string[],limit:number,env:NodeJS.ProcessEnv)=>Promise<Buffer>};
const assetStages=['command bound','tool unavailable','tool output bound','download response','download declared size','download bound','empty download','download','API metadata',
  'asset inventory','asset nomination','asset identity','independent download digest','signing certificate','ZIP listing','ZIP entries','ARM64 native libraries','ARM64 ELF',
  'invocation','version code','public release','tag source','release manifest','source-bound release manifest','nominated platform','nominated receipt','receipt/API agreement',
  'owned directory','stored APK digest','Android SDK','APK manifest identity','unavailable'] as const;
class PublishedAssetError extends Error {
  constructor(readonly stage:typeof assetStages[number]){super(`Published Android asset rejected: ${stage}`);}
}
export function publishedAssetFailure(error:unknown):typeof assetStages[number]{
  try{if(error instanceof PublishedAssetError){const stage=error.stage;if(assetStages.includes(stage))return stage;}}catch{}
  return 'unavailable';
}
function requirePublished(condition:unknown,stage:typeof assetStages[number]):asserts condition {
  if(!condition)throw new PublishedAssetError(stage);
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const shaPattern=/^[a-f0-9]{40}$/,digestPattern=/^[a-f0-9]{64}$/;

/** No raw child stdout/stderr enters the reusable process owner's retained windows. */
export async function publishedAssetCommand(program:string,args:string[],limit:number,env=process.env,milliseconds=30_000):Promise<Buffer>{
  requirePublished(Number.isSafeInteger(limit)&&limit>0&&limit<=apkLimit&&Number.isInteger(milliseconds)&&milliseconds>0&&milliseconds<=30_000,'command bound');
  const process=new OwnedProcess(program,args,undefined,env,false);
  const chunks:Buffer[]=[];let length=0,overflow=false;
  process.child.stdout!.on('data',(chunk:Buffer)=>{
    length+=chunk.length;
    if(length>limit){overflow=true;chunks.length=0;}else if(!overflow)chunks.push(Buffer.from(chunk));
  });
  try {await process.finish('published APK verification',milliseconds);}
  catch {throw new PublishedAssetError('tool unavailable');}
  requirePublished(!overflow,'tool output bound');
  return Buffer.concat(chunks,length);
}
const io:PublishedAssetIo={fetch:(...args)=>fetch(...args),command:publishedAssetCommand};
async function download(url:string,maximum:number,transport:typeof fetch){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30_000);
  try {
    const response=await transport(url,{signal:controller.signal,headers:{Accept:'application/vnd.github+json'}});
    requirePublished(response.ok&&response.body,'download response');
    const declared=response.headers.get('content-length');
    requirePublished(declared===null||(/^\d+$/.test(declared)&&Number(declared)<=maximum),'download declared size');
    const chunks:Uint8Array[]=[];let length=0;
    const reader=response.body!.getReader();
    try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;
      requirePublished(length<=maximum,'download bound');chunks.push(value);}}
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    requirePublished(length>0,'empty download');
    return Buffer.concat(chunks,length);
  }catch{throw new PublishedAssetError('download');}
  finally{clearTimeout(timeout);}
}
async function json(url:string,transport:typeof fetch){
  try{return JSON.parse((await download(url,apiLimit,transport)).toString('utf8'));}
  catch{throw new PublishedAssetError('API metadata');}
}
function asset(release:Record<string,unknown>,name:string,tag:string,maximum:number):Asset{
  requirePublished(Array.isArray(release.assets)&&release.assets.length<=64,'asset inventory');
  const selected=release.assets.filter((value:Asset)=>value?.name===name);
  requirePublished(selected.length===1,'asset nomination');
  const value=selected[0] as Asset;
  requirePublished(Number.isSafeInteger(value.size)&&value.size>0&&value.size<=maximum
    &&typeof value.digest==='string'&&/^sha256:[a-f0-9]{64}$/.test(value.digest)
    &&value.browser_download_url===`https://github.com/mihazs/lazysh/releases/download/${tag}/${name}`,'asset identity');
  return value;
}
function matchingDownload(bytes:Buffer,entry:Asset){
  requirePublished(bytes.length===entry.size&&`sha256:${hash(bytes)}`===entry.digest,'independent download digest');
}
export function publishedApkSignature(text:string,expected:string){
  const signers=[...text.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})\r?$/gm)];
  requirePublished(signers.length===1&&signers[0][1].toLowerCase()===expected,'signing certificate');
  return expected;
}
export function publishedNativeLibraries(text:string){
  requirePublished(text.length<=1024*1024&&!text.includes('\0'),'ZIP listing');
  const entries=text.split(/\r?\n/).filter(Boolean);
  requirePublished(entries.length<=16_384&&new Set(entries).size===entries.length,'ZIP entries');
  const libraries=entries.filter(entry=>entry.startsWith('lib/')&&!entry.endsWith('/'));
  requirePublished(libraries.length>0&&libraries.length<=64
    &&libraries.every(entry=>/^lib\/arm64-v8a\/[a-zA-Z0-9_.+-]+\.so$/.test(entry))
    &&libraries.includes('lib/arm64-v8a/liblazysh_lib.so'),'ARM64 native libraries');
  return libraries;
}
export function publishedArm64Elf(bytes:Buffer){
  requirePublished(bytes.length>=64&&bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))
    &&bytes[4]===2&&bytes[5]===1&&bytes[6]===1&&bytes.readUInt16LE(18)===183,'ARM64 ELF');
}

/** Verify only the nominated public APK, not the current main branch's release inventory. */
async function prepare(tag:string,flavor:Flavor,directory:string,expectedCertificate:string,env=process.env,operations:PublishedAssetIo=io):Promise<PublishedApk>{
  requirePublished(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
    &&['google','foss'].includes(flavor)&&isAbsolute(directory)&&digestPattern.test(expectedCertificate.toLowerCase()),'invocation');
  const version=tag.slice(1),certificateSha256=expectedCertificate.toLowerCase();
  const components=version.split('.').map(Number),code=components[0]*1_000_000+components[1]*1_000+components[2];
  requirePublished(components.every(Number.isSafeInteger)&&components[1]<1000&&components[2]<1000&&Number.isSafeInteger(code)&&code<=2_100_000_000,'version code');
  const release=await json(`${repository}/releases/tags/${tag}`,operations.fetch);
  requirePublished(release&&release.tag_name===tag&&release.draft===false&&release.prerelease===false,'public release');
  const ref=await json(`${repository}/git/ref/tags/${tag}`,operations.fetch);
  let object=ref?.object;
  if(object?.type==='tag'&&shaPattern.test(object.sha))object=(await json(`${repository}/git/tags/${object.sha}`,operations.fetch))?.object;
  requirePublished(object?.type==='commit'&&shaPattern.test(object.sha),'tag source');
  const sha=object.sha as string;
  const nominated=asset(release,'release.json',tag,metadataLimit);
  const manifestBytes=await download(nominated.browser_download_url,metadataLimit,operations.fetch);
  matchingDownload(manifestBytes,nominated);
  let manifest;try{manifest=JSON.parse(manifestBytes.toString('utf8'));}catch{throw new PublishedAssetError('release manifest');}
  requirePublished(manifest?.schema===1&&manifest.sha===sha&&manifest.version===version&&Array.isArray(manifest.platforms)
    &&manifest.platforms.length>0&&manifest.platforms.length<=32,'source-bound release manifest');
  const target=`android-${flavor}-arm64` as const;
  const receipts=manifest.platforms.filter((value:{target?:string})=>value?.target===target);
  requirePublished(receipts.length===1,'nominated platform');
  let receipt;try{receipt=validateReceipt(receipts[0],{sha,version});}catch{throw new PublishedAssetError('nominated receipt');}
  const expected=receipt.files[0],name=artifactName({sha,version},target,'apk');
  const apkAsset=asset(release,name,tag,apkLimit);
  requirePublished(apkAsset.size===expected.bytes&&apkAsset.digest===`sha256:${expected.sha256}`,'receipt/API agreement');
  const bytes=await download(apkAsset.browser_download_url,apkLimit,operations.fetch);matchingDownload(bytes,apkAsset);
  // A fresh leaf directory and exclusive no-follow file prevent adopting existing bytes.
  await mkdir(directory,{mode:0o700});
  requirePublished(await realpath(directory)===directory&&(await lstat(directory)).isDirectory(),'owned directory');
  const apk=join(directory,name),file=await open(apk,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(bytes);}finally{await file.close();bytes.fill(0);}
  const digest=await digestFile(apk,apkLimit);
  requirePublished(digest.bytes===expected.bytes&&digest.sha256===expected.sha256,'stored APK digest');
  const sdk=env.ANDROID_HOME;requirePublished(sdk&&isAbsolute(sdk),'Android SDK');
  const command=async(program:string,args:string[],limit=metadataLimit)=>(await operations.command(program,args,limit,env)).toString('utf8').trim();
  const analyzer=join(sdk,'cmdline-tools/latest/bin/apkanalyzer');
  for(const [field,value] of [['application-id','app.lazysh.client'],['version-name',version],['version-code',String(code)],['debuggable','false']])
    requirePublished(await command(analyzer,['manifest',field,apk])===value,'APK manifest identity');
  publishedApkSignature(await command(join(sdk,'build-tools/36.0.0/apksigner'),['verify','--verbose','--print-certs',apk]),certificateSha256);
  const libraries=publishedNativeLibraries(await command('/usr/bin/unzip',['-Z1',apk],1024*1024));
  for(const library of libraries){const elf=await operations.command('/usr/bin/unzip',['-p',apk,library],apkLimit,env);try{publishedArm64Elf(elf);}finally{elf.fill(0);}}
  return {apk,sha,version,tag,flavor,sha256:digest.sha256,bytes:digest.bytes,certificateSha256};
}

export async function preparePublishedApk(tag:string,flavor:Flavor,directory:string,expectedCertificate:string,env=process.env,operations:PublishedAssetIo=io):Promise<PublishedApk>{
  try{return await prepare(tag,flavor,directory,expectedCertificate,env,operations);}
  catch(error){if(error instanceof PublishedAssetError)throw error;throw new PublishedAssetError('unavailable');}
}
