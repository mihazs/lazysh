import {createHash} from 'node:crypto';
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
async function bytes(url:URL,maximum:number,binary=false,redirects=0):Promise<Buffer> {
  requirePublic(allowed(url) && redirects<=3);
  const value=await new Promise<Buffer|URL>((resolve,reject)=>{
    const fail=()=>reject(new Error('Direct public GitHub evidence request failed'));
    const req=request(url,{signal:AbortSignal.timeout(30_000),headers:{'User-Agent':'lazysh-published-native-acceptance',Accept:binary?'application/octet-stream':'application/vnd.github+json','Accept-Encoding':'identity'}},response=>{
      if([301,302,303,307,308].includes(response.statusCode??0) && response.headers.location) {
        response.destroy();
        try{resolve(new URL(response.headers.location,url));}catch{fail();}
        return;
      }
      if(response.statusCode!==200 || (response.headers['content-encoding'] && response.headers['content-encoding']!=='identity')){response.destroy();fail();return;}
      const chunks:Buffer[]=[];let length=0;
      response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>maximum){response.destroy();fail();}else chunks.push(chunk);});
      response.on('end',()=>resolve(Buffer.concat(chunks)));
      response.on('error',fail);
    });
    req.on('error',fail);req.end();
  });
  return value instanceof URL?bytes(value,maximum,binary,redirects+1):value;
}
async function json(path:string) {
  try{return JSON.parse((await bytes(new URL(path,api),262_144)).toString('utf8'));}
  catch{throw new Error('Direct public GitHub metadata is unavailable or invalid');}
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
