import {createHash} from 'node:crypto';
import {constants,type Stats} from 'node:fs';
import {open,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {SshFixture} from '../../../tests/support/sshFixture';
import {request} from 'node:https';
import {assertDirectDriverEnvironment} from '../native-e2e/policy';

const api='https://api.github.com/repos/mihazs/lazysh/';
const sha256=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
type Asset={id:number;name:string;size:number;digest:string};
type Release={id:number;tag_name:string;draft:boolean;prerelease:boolean;assets:Asset[]};
export type PublishedCompanion={releaseId:number;version:string;source:string;assetId:number;name:string;bytes:number;sha256:string};
function requirePublic(value:unknown):asserts value {
  if(!value)throw new Error('Published companion evidence is missing, changed or invalid');
}
function allowed(url:URL) {
  return url.protocol==='https:' && !url.username && !url.password && !url.port && (
    (url.hostname==='api.github.com' && url.pathname.startsWith('/repos/mihazs/lazysh/'))
    || ['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname));
}
// Each failure names only a fixed stage; no response body, header or URL reaches the message.
const failure=(category:string)=>new Error(`Direct public GitHub evidence request failed: ${category}`);
function requestCategory(error:unknown) {
  const {name,code}=(error ?? {}) as {name?:unknown;code?:unknown};
  if(name==='TimeoutError' || name==='AbortError')return 'timeout';
  return typeof code==='string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)?`network error ${code}`:'network error';
}
export async function bytes(url:URL,maximum:number,binary=false,redirects=0,send:typeof request=request):Promise<Buffer> {
  requirePublic(allowed(url) && redirects<=3);
  const value=await new Promise<Buffer|URL>((resolve,reject)=>{
    const fail=(category:string)=>reject(failure(category));
    const req=send(url,{signal:AbortSignal.timeout(30_000),headers:{'User-Agent':'lazysh-published-native-acceptance',Accept:binary?'application/octet-stream':'application/vnd.github+json','Accept-Encoding':'identity'}},response=>{
      const status=response.statusCode??0;
      if([301,302,303,307,308].includes(status) && response.headers.location) {
        response.destroy();
        try{resolve(new URL(response.headers.location,url));}catch{fail('invalid redirect');}
        return;
      }
      if(status!==200){response.destroy();fail(`HTTP status ${status}`);return;}
      if(response.headers['content-encoding'] && response.headers['content-encoding']!=='identity'){response.destroy();fail('unsupported content encoding');return;}
      const chunks:Buffer[]=[];let length=0;
      response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>maximum){response.destroy();fail('response too large');}else chunks.push(chunk);});
      response.on('end',()=>resolve(Buffer.concat(chunks)));
      response.on('error',error=>fail(`response ${requestCategory(error)}`));
    });
    req.on('error',error=>fail(requestCategory(error)));req.end();
  });
  return value instanceof URL?bytes(value,maximum,binary,redirects+1,send):value;
}
export async function json(path:string,send?:typeof request) {
  const body=await bytes(new URL(path,api),262_144,false,0,send);
  try{return JSON.parse(body.toString('utf8'));}
  catch{throw new Error('Direct public GitHub metadata is invalid: response is not JSON');}
}
function asset(release:Release,name:string):Asset {
  const selected=release.assets.filter(value=>value.name===name);
  requirePublic(selected.length===1);
  const value=selected[0];
  requirePublic(Number.isSafeInteger(value.id) && value.id>0 && Number.isSafeInteger(value.size) && value.size>0 && /^sha256:[0-9a-f]{64}$/.test(value.digest));
  return value;
}
export async function publishedCompanion():Promise<PublishedCompanion> {
  assertDirectDriverEnvironment(process.env);
  const release:Release=await json('releases/latest');
  requirePublic(release && Number.isSafeInteger(release.id) && !release.draft && !release.prerelease && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name) && Array.isArray(release.assets) && release.assets.length<=32);
  const version=release.tag_name.slice(1),manifestAsset=asset(release,'release.json');
  requirePublic(manifestAsset.size<=65_536);
  const body=await bytes(new URL(`releases/assets/${manifestAsset.id}`,api),65_536,true);
  requirePublic(body.length===manifestAsset.size && `sha256:${sha256(body)}`===manifestAsset.digest);
  let manifest;
  try{manifest=JSON.parse(body.toString('utf8'));}catch{throw new Error('Public release manifest is not JSON');}
  const reference=await json(`git/ref/tags/${release.tag_name}`);
  requirePublic(manifest.schema===1 && manifest.version===version && /^[a-f0-9]{40}$/.test(manifest.sha) && reference.ref===`refs/tags/${release.tag_name}` && reference.object?.type==='commit' && reference.object.sha===manifest.sha && Array.isArray(manifest.platforms) && manifest.platforms.length<=32);
  const selected=manifest.platforms.filter((value:{target?:unknown})=>value?.target==='linux-agent-x64');
  requirePublic(selected.length===1);
  const receipt=selected[0];
  requirePublic(receipt.schema===1 && receipt.version===version && receipt.sha===manifest.sha && ['unsigned','signed'].includes(receipt.signing) && Array.isArray(receipt.files) && receipt.files.length===1);
  const file=receipt.files[0];
  requirePublic(file.name===`lazysh-${version}-linux-agent-x64.bin` && Number.isSafeInteger(file.bytes) && file.bytes>0 && file.bytes<=64*1024*1024 && /^[0-9a-f]{64}$/.test(file.sha256));
  const binary=asset(release,file.name);
  requirePublic(binary.size===file.bytes && binary.digest===`sha256:${file.sha256}`);
  return {releaseId:release.id,version,source:manifest.sha,assetId:binary.id,name:file.name,bytes:file.bytes,sha256:file.sha256};
}

export async function installedCompanion(fixture:SshFixture,evidence:PublishedCompanion) {
  const path=join(fixture.directory,'data/lazysh/companion/lazysh-agent');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let before:Stats;
  try {
    before=await handle.stat();
    requirePublic(before.isFile() && before.uid===process.getuid!() && before.nlink===1 && (before.mode&0o777)===0o700 && before.size===evidence.bytes);
    const digest=createHash('sha256');let length=0;
    for await(const chunk of handle.createReadStream({autoClose:false})) {
      length+=chunk.length;requirePublic(length<=evidence.bytes);digest.update(chunk);
    }
    requirePublic(length===evidence.bytes && digest.digest('hex')===evidence.sha256);
    const after=await handle.stat();
    requirePublic([after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].every((value,index)=>value===[before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs][index]));
  } finally {await handle.close();}
  const version=await fixture.client(true,`${path} --version`);
  requirePublic((await version.finish('published installed companion version',5000)).trim()===`lazysh-agent ${evidence.version}`);
  requirePublic(!(await readdir(fixture.directory)).some(name=>name.startsWith('.lazysh-install-')));
  return {path,identity:[before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs]};
}
