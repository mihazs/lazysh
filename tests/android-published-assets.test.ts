import {expect,test} from 'bun:test';
import {mkdtemp,mkdir,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {preparePublishedApk,publishedApkSignature,publishedNativeLibraries,publishedArm64Elf,publishedAssetCommand,type PublishedAssetIo} from './support/androidPublishedAssets';

const sha='a'.repeat(40),certificate='b'.repeat(64),tag='v0.23.0',name='lazysh-0.23.0-android-foss-arm64.apk';
const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const apk=Buffer.from('synthetic public APK bytes'),elf=Buffer.alloc(64);
elf.set([0x7f,0x45,0x4c,0x46,2,1,1]);elf.writeUInt16LE(183,18);
async function fixture(action:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await action(f);}finally{await rm(f.root,{recursive:true,force:true});}}
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'lazysh-published-assets-'));
  const receipt={schema:1,sha,version:'0.23.0',target:'android-foss-arm64',signing:'signed',files:[{name,bytes:apk.length,sha256:digest(apk)}]};
  const manifest={schema:1,sha,version:'0.23.0',platforms:[{target:'linux-x64'},receipt,{target:'android-google-arm64'},{target:'windows-x64'}]};
  const release:{tag_name:string;draft:boolean;prerelease:boolean;assets:unknown[]}={tag_name:tag,draft:false,prerelease:false,assets:[]};
  const payloads=new Map<string,Buffer>(),calls:{program:string;args:string[];limit:number}[]=[];
  const base=`https://github.com/mihazs/lazysh/releases/download/${tag}/`,api='https://api.github.com/repos/mihazs/lazysh';
  function refresh(){
    const bytes=Buffer.from(JSON.stringify(manifest));
    release.assets=[{name:'release.json',size:bytes.length,digest:`sha256:${digest(bytes)}`,browser_download_url:`${base}release.json`},
      {name,size:apk.length,digest:`sha256:${digest(apk)}`,browser_download_url:base+name}];
    payloads.set(`${api}/releases/tags/${tag}`,Buffer.from(JSON.stringify(release)));
    payloads.set(`${api}/git/ref/tags/${tag}`,Buffer.from(JSON.stringify({object:{type:'commit',sha}})));
    payloads.set(base+'release.json',bytes);payloads.set(base+name,apk);
  }
  refresh();
  const operations:PublishedAssetIo={
    fetch:(async(url:unknown)=>{const value=payloads.get(String(url));if(!value)return new Response('missing',{status:404});
      return new Response(new ReadableStream({start(controller){controller.enqueue(value.subarray(0,3));controller.enqueue(value.subarray(3));controller.close();}}));}) as typeof fetch,
    command:async(program,args,limit)=>{
      calls.push({program,args,limit});
      if(program.endsWith('apkanalyzer'))return Buffer.from(({ 'application-id':'app.lazysh.client','version-name':'0.23.0','version-code':'23000',debuggable:'false'} as Record<string,string>)[args[1]]);
      if(program.endsWith('apksigner'))return Buffer.from(`Signer #1 certificate SHA-256 digest: ${certificate}\n`);
      return args[0]==='-Z1'?Buffer.from('classes.dex\nlib/\nlib/arm64-v8a/\nlib/arm64-v8a/liblazysh_lib.so\n'):Buffer.from(elf);
    },
  };
  const run=(directory=join(root,'download'))=>preparePublishedApk(tag,'foss',directory,certificate,{ANDROID_HOME:'/sdk'},operations);
  return {root,run,manifest,receipt,release,payloads,operations,calls,refresh,base,api};
}

test('nominated historical four-platform release binds tag, receipt, API digest and exact APK without current inventory',()=>fixture(async f=>{
  const result=await f.run();
  expect(result).toEqual({apk:join(f.root,'download',name),tag,flavor:'foss',sha,version:'0.23.0',bytes:apk.length,sha256:digest(apk),certificateSha256:certificate});
  expect(await readFile(result.apk)).toEqual(apk);
  expect(f.calls.filter(c=>c.program.endsWith('apkanalyzer')).map(c=>c.args[1])).toEqual(['application-id','version-name','version-code','debuggable']);
  expect(f.calls.at(-1)?.args).toEqual(['-p',result.apk,'lib/arm64-v8a/liblazysh_lib.so']);
}));

test.each(['draft','prerelease','source','receipt','duplicate','api-digest','body-digest','missing-digest','foreign-url'] as const)('reject public nomination substitution: %s',kind=>fixture(async f=>{
  if(kind==='draft'||kind==='prerelease'){f.release[kind]=true;f.refresh();}
  if(kind==='source'){f.manifest.sha='c'.repeat(40);f.refresh();}
  if(kind==='receipt'){f.receipt.sha='c'.repeat(40);f.refresh();}
  if(kind==='duplicate'){f.manifest.platforms.push(f.receipt);f.refresh();}
  if(['api-digest','missing-digest','foreign-url'].includes(kind)){
    const value=f.release.assets[1] as {digest?:string;browser_download_url:string};
    if(kind==='api-digest')value.digest=`sha256:${'c'.repeat(64)}`;
    if(kind==='missing-digest')delete value.digest;
    if(kind==='foreign-url')value.browser_download_url='https://example.invalid/private';
    f.payloads.set(`${f.api}/releases/tags/${tag}`,Buffer.from(JSON.stringify(f.release)));
  }
  if(kind==='body-digest')f.payloads.set(f.base+name,Buffer.from('substituted'));
  await expect(f.run()).rejects.toThrow('Published Android asset rejected:');
  expect(f.calls).toHaveLength(0);
}));

test('bounded annotated tag peel is accepted only when it resolves to manifest source',()=>fixture(async f=>{
  f.payloads.set(`${f.api}/git/ref/tags/${tag}`,Buffer.from(JSON.stringify({object:{type:'tag',sha:'d'.repeat(40)}})));
  f.payloads.set(`${f.api}/git/tags/${'d'.repeat(40)}`,Buffer.from(JSON.stringify({object:{type:'commit',sha}})));
  expect((await f.run()).sha).toBe(sha);
}));

test('existing directory and symlink are never adopted or overwritten',()=>fixture(async f=>{
  const directory=join(f.root,'present');await mkdir(directory);await expect(f.run(directory)).rejects.toThrow('unavailable');
  const link=join(f.root,'link');await symlink(directory,link);await expect(f.run(link)).rejects.toThrow('unavailable');
}));

test.each(['manifest','certificate','abi','elf','tool-error'] as const)('APK verification fails closed for %s without retaining private output',kind=>fixture(async f=>{
  const original=f.operations.command;
  f.operations.command=async(program,args,limit,env)=>{
    if(kind==='tool-error')throw new Error('/private/path PRIVATE_FIXTURE_SENTINEL');
    if(kind==='manifest'&&program.endsWith('apkanalyzer'))return Buffer.from('PRIVATE_FIXTURE_SENTINEL');
    if(kind==='certificate'&&program.endsWith('apksigner'))return Buffer.from('PRIVATE_FIXTURE_SENTINEL');
    if(kind==='abi'&&args[0]==='-Z1')return Buffer.from('lib/x86_64/liblazysh_lib.so\nPRIVATE_FIXTURE_SENTINEL');
    if(kind==='elf'&&args[0]==='-p')return Buffer.from('PRIVATE_FIXTURE_SENTINEL');
    return original(program,args,limit,env);
  };
  try{await f.run();throw new Error('expected rejection');}catch(error){expect(String(error)).toContain('Published Android asset rejected:');expect(String(error)).not.toContain('PRIVATE_FIXTURE_SENTINEL');expect(String(error)).not.toContain('/private/path');}
}));

test('download body and API metadata are bounded even without declared size',()=>fixture(async f=>{
  f.payloads.set(`${f.api}/releases/tags/${tag}`,Buffer.alloc(128*1024+1));
  await expect(f.run()).rejects.toThrow('API metadata');
}));

test('closed signature/ZIP/ELF parsers reject ambiguity, mixed ABIs, malformed headers and duplicates',()=>{
  expect(publishedApkSignature(`Signer #1 certificate SHA-256 digest: ${certificate}\n`,certificate)).toBe(certificate);
  expect(()=>publishedApkSignature([1,2].map(n=>`Signer #${n} certificate SHA-256 digest: ${certificate}`).join('\n'),certificate)).toThrow();
  for(const listing of ['lib/arm64-v8a/liblazysh_lib.so\nlib/x86_64/libother.so','lib/arm64-v8a/liblazysh_lib.so\nlib/arm64-v8a/liblazysh_lib.so','lib/arm64-v8a/../liblazysh_lib.so'])expect(()=>publishedNativeLibraries(listing)).toThrow();
  publishedArm64Elf(elf);const x86=Buffer.from(elf);x86.writeUInt16LE(62,18);expect(()=>publishedArm64Elf(x86)).toThrow();
});

test.skipIf(process.platform!=='linux')('real foreground child output is bounded, stderr excluded, nonzero and timeout remain closed',async()=>{
  expect(await publishedAssetCommand(process.execPath,['-e',"process.stderr.write('PRIVATE_FIXTURE_SENTINEL');process.stdout.write('ok')"],4)).toEqual(Buffer.from('ok'));
  await expect(publishedAssetCommand(process.execPath,['-e',"process.stdout.write('12345')"],4)).rejects.toThrow('tool output bound');
  await expect(publishedAssetCommand(process.execPath,['-e',"process.stderr.write('PRIVATE_FIXTURE_SENTINEL');process.exit(1)"],4)).rejects.toThrow('tool unavailable');
  await expect(publishedAssetCommand(process.execPath,['-e','setInterval(()=>{},1000)'],4,process.env,50)).rejects.toThrow('tool unavailable');
});
