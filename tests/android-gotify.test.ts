import {createHash} from 'node:crypto';
import {expect,test} from 'bun:test';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {OwnedProcess} from './support/ownedProcess';
import {resolve} from 'node:path';
import {gotifyStage,gotifyMessage,gotifyNativeReport,gotifyPrivateCommand,gotifyUid,gotifyCase,gotifyOfficialArtifact,gotifyPrivateStage,gotifyProxyAdmission,gotifyDeviceAction,GotifyReverse,gotifyInstalledApk,OwnedGotifyPackages,ownedGotifyAndroid} from './support/androidGotify';

const nonce='0123456789abcdef0123456789abcdef';
const background={schemaVersion:1,nonce,step:0,background:true};
test('background stage accepts only the exact owner and completed native facts',()=>{
  expect(gotifyStage(JSON.stringify(background),nonce,0)).toEqual({step:0,verified:true});
  for(const changed of [{...background,nonce:'f'.repeat(32)},{...background,background:false},{...background,step:1},
    {...background,token:'private-value'},{...background,schemaVersion:2},null,[],{}])
    expect(()=>gotifyStage(JSON.stringify(changed),nonce,0)).toThrow('Owned Gotify acceptance rejected');
  for(const text of [JSON.stringify(background).replace('"step":0','"step":9,"step":0'),'{',JSON.stringify(background)+' '.repeat(2048)])
    expect(()=>gotifyStage(text,nonce,0)).toThrow();
});
test('finite event observations require the same server ID, state, OS record and visible card',()=>{
  for(let step=0;step<3;step++) {
    const message=gotifyMessage(nonce,step,17+step);
    const value={schemaVersion:1,nonce,step:step+1,messageId:message.messageId,state:message.state,osRecord:true,visibleCard:true,background:true};
    expect(gotifyStage(JSON.stringify(value),nonce,step+1,message.messageId).verified).toBe(true);
    for(const changed of [{...value,messageId:message.messageId+1},{...value,state:'unknown'},{...value,osRecord:false},{...value,visibleCard:false},{...value,background:false}])
      expect(()=>gotifyStage(JSON.stringify(changed),nonce,step+1,message.messageId)).toThrow();
    expect(message.priority).toBe(step===1?5:2);
  }
  expect(gotifyStage(JSON.stringify({schemaVersion:1,nonce,step:4,history:true}),nonce,4).verified).toBe(true);
  expect(()=>gotifyStage(JSON.stringify({...background,step:4}),nonce,4)).toThrow();
  for(const id of [0,-1,2147483648,NaN,1.5])expect(()=>gotifyMessage(nonce,0,id)).toThrow();
});
test('private handoff admits only fixed nonce-owned leaves, not arbitrary shell text',()=>{
  expect(gotifyPrivateCommand(nonce)).toContain(`cat > files/.lazysh-gotify-${nonce}.json`);
  expect(gotifyPrivateCommand(nonce,'.message-2.tmp')).toContain('set -C && cat >');
  for(const suffix of ['.message-3.tmp','.stage-0.json',';echo private','../token'])expect(()=>gotifyPrivateCommand(nonce,suffix)).toThrow();
  for(const owner of ['',nonce+'\n',nonce.toUpperCase(),'$(id)'])expect(()=>gotifyPrivateCommand(owner)).toThrow();
});
test('installed UID and exact native XML cannot be replaced by HTTP or a skipped case',()=>{
  expect(gotifyUid('package:com.github.gotify uid:10234\n')).toBe(10234);
  for(const value of ['package:other uid:10234\n','package:com.github.gotify uid:0\n','package:com.github.gotify uid:10234\nextra'])expect(()=>gotifyUid(value)).toThrow();
  const testCase=`<testcase name="${gotifyCase}" classname="app.lazysh.client.GotifyAndroidTest"/>`;
  const xml=`<testsuite tests="1" failures="0" errors="0" skipped="0">${testCase}</testsuite>`;
  expect(gotifyNativeReport(xml)).toEqual({passed:1,failed:0,skipped:0});
  for(const changed of [xml.replace('/>','><skipped/></testcase>'),xml.replace('tests="1"','tests="0"'),xml.replace('GotifyAndroidTest','OtherTest'),
    xml.replace('</testsuite>',testCase+'</testsuite>'),'HTTP200',xml.replace('/>','><failure/></testcase>')])expect(()=>gotifyNativeReport(changed)).toThrow();
});
test('private stage rejects changed ownership, partial bodies and mutable final links',()=>{
  const body=JSON.stringify(background),metadata=`10235 600 1 ${Buffer.byteLength(body)} 8 1234 8180`;
  const raw=`${metadata}\n${body}\n${metadata}\n`;
  expect(gotifyPrivateStage(raw,nonce,0,10235)).toEqual({step:0,verified:true});
  expect(gotifyPrivateStage('pending\n',nonce,0,10235)).toBeUndefined();
  expect(gotifyPrivateStage(raw.replaceAll('600 1','600 2'),nonce,0,10235)).toBeUndefined();
  for(const changed of [raw.replaceAll('10235','10236'),raw.replaceAll('600 1','644 1'),raw.replaceAll('600 1','600 3'),
    raw.replaceAll('8180','a180'),raw.replace('1234','1235'),raw.replace(body,'{}')])
    expect(()=>gotifyPrivateStage(changed,nonce,0,10235)).toThrow();
});
test('exact artifact bytes and one observed release signer are both required',()=>{
  const bytes=Buffer.from('synthetic-owned-artifact'),hash=createHash('sha256').update(bytes).digest('hex');
  const pin={size:bytes.length,sha256:hash},signer={output:`Signer #1 certificate SHA-256 digest: ${hash}`,sha256:hash};
  expect(()=>gotifyOfficialArtifact(bytes,pin,signer)).not.toThrow();
  for(const invalid of [{...pin,size:pin.size+1},{...pin,sha256:'0'.repeat(64)}])expect(()=>gotifyOfficialArtifact(bytes,invalid,signer)).toThrow();
  for(const invalid of [{...signer,output:signer.output+'\n'+signer.output},{...signer,sha256:'0'.repeat(64)},{...signer,output:'not verified'}])
    expect(()=>gotifyOfficialArtifact(bytes,pin,invalid)).toThrow();
});
test('official artifact provenance records immutable release identities and the signing-pin limitation',async()=>{
  const pin=JSON.parse(await readFile(resolve(import.meta.dir,'../apps/client/src-tauri/fixtures/gotify-provenance.json'),'utf8'));
  expect(pin.android).toMatchObject({version:'2.10.1',applicationId:'com.github.gotify',targetSdk:36,versionCode:36,assetId:468223910,size:6764847});
  expect(pin.server).toMatchObject({version:'3.1.1',assetId:566290671,member:'gotify-linux-amd64'});
  expect(pin.android.signerBasis).toContain('not an independently published signing pin');
  for(const hash of [pin.android.sha256,pin.android.observedSignerSha256,pin.server.sha256,pin.server.executableSha256])expect(hash).toMatch(/^[a-f0-9]{64}$/);
});

test('fake loopback transport excludes inherited proxies and bounds verified HTTP/TLS responses',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'.lazysh-gotify-transport-'));
  const cert=join(dir,'cert.pem'),key=join(dir,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',key,'-out',cert],{stdio:'ignore'});
  let proxyHits=0,requests=0,cancelled=0,active='admission';
  const observed:{kind:string;phase:string;route:string;fakeAuth:boolean}[]=[];
  const observe=(kind:string,request:Request)=>observed.push({kind,phase:active,route:['/ok','/large','/stall'].includes(new URL(request.url).pathname)?new URL(request.url).pathname:'other',fakeAuth:request.headers.get('authorization')==='Bearer owned-fake-only'});
  const fake=(request:Request)=>{
    requests++;observe('target',request);if(request.headers.get('authorization')!=='Bearer owned-fake-only')return new Response('{}',{status:403});
    if(new URL(request.url).pathname==='/ok')return Response.json({fake:true});
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(new URL(request.url).pathname==='/large'?'x'.repeat(65537):'{'));},cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}});
  };
  const proxy=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){proxyHits++;observe('proxy',request);return Response.json({proxy:true});}});
  const http=Bun.serve({hostname:'127.0.0.1',port:0,fetch:fake});
  const tls=Bun.serve({hostname:'127.0.0.1',port:0,tls:{cert:await readFile(cert),key:await readFile(key)},fetch:fake});
  const imports=`import {gotifyJsonRequest as request} from ${JSON.stringify(resolve(import.meta.dir,'support/androidGotify.ts'))};
    const ca=Buffer.from(await Bun.file(process.env.FAKE_CA).arrayBuffer()),http=process.env.FAKE_HTTP,tls=process.env.FAKE_TLS,auth='Bearer owned-fake-only';`;
  const script=imports+`
    let failed=false,phase='http';try {
      for(const [origin,trust] of [[http,undefined],[tls,ca]]) {
        phase=origin.startsWith('https:')?'tls':'http';
        if((await request(origin,'/ok','GET',auth,undefined,trust)).fake!==true)failed=true;
        const start=performance.now();let rejected=false;try{await request(origin,'/large','GET',auth,undefined,trust);}catch{rejected=true;}
        if(!rejected||performance.now()-start>2000)failed=true;
      }
      let untrusted=false;try{await request(tls,'/ok','GET',auth,undefined);}catch{untrusted=true;}
      let wrongHostname=false;try{await request(tls.replace('localhost','127.0.0.1'),'/ok','GET',auth,undefined,ca);}catch{wrongHostname=true;}
      phase='body-deadline';const start=performance.now();let expired=false;try{await request(tls,'/stall','GET',auth,undefined,ca);}catch{expired=true;}
      const elapsed=performance.now()-start;
      if(!untrusted||!wrongHostname||!expired||elapsed<2700||elapsed>4500)failed=true;
      console.log(JSON.stringify({transportPassed:!failed}));process.exit(failed?1:0);
    }catch{console.log(JSON.stringify({transportPassed:false,phase}));process.exit(1);}`;
  const proxyScript=imports+`let rejected=0;for(const [origin,trust] of [[http,undefined],[tls,ca]]) {
    try{await request(origin,'/ok','GET',auth,undefined,trust);}catch(error){if(error.message==='Owned Gotify fixture requires a proxy-free child environment')rejected++;}
  }console.log(JSON.stringify({rejected}));process.exit(rejected===2?0:1);`;
  const proxyNames=['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'];
  const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!proxyNames.includes(key)));
  const env={...clean,FAKE_CA:cert,FAKE_HTTP:`http://127.0.0.1:${http.port}`,FAKE_TLS:`https://localhost:${tls.port}`};
  const children:OwnedProcess[]=[];
  try {
    for(const name of proxyNames) {
      active=name;const child=new OwnedProcess(process.execPath,['-e',proxyScript],undefined,{...env,[name]:`http://127.0.0.1:${proxy.port}`,NO_PROXY:'*',no_proxy:'*'});children.push(child);
      expect(JSON.parse((await child.finish('fake proxy rejection',2000)).trim())).toEqual({rejected:2});
    }
    expect(proxyHits).toBe(0);expect(requests).toBe(0);
    active='clean-child';const child=new OwnedProcess(process.execPath,['-e',script],undefined,env);children.push(child);
    expect(JSON.parse((await child.finish('fake direct/TLS transport',6500)).trim())).toEqual({transportPassed:true});
    expect(proxyHits).toBe(0);expect(requests).toBe(5);expect(cancelled).toBe(3);
  }finally{
    for(const child of children)await child.stop();
    console.log('Owned fake transport observation '+JSON.stringify({proxyHits,requests,cancelled,observed}));
    proxy.stop(true);http.stop(true);tls.stop(true);await rm(dir,{recursive:true,force:true});
  }
},15000);

test('device actions fail before execution when the full continuity fence rejects',async()=>{
  let invoked=0;
  const action=()=>gotifyDeviceAction(async()=>{throw new Error('owned identity changed');},async()=>{invoked++;});
  await expect(action()).rejects.toThrow('owned identity changed');
  expect(invoked).toBe(0);
  expect(await gotifyDeviceAction(async()=>{},async()=>++invoked)).toBe(1);
  for(const name of ['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'])
    expect(()=>gotifyProxyAdmission({[name]:'fake-proxy',NO_PROXY:'*'})).toThrow('proxy-free child');
});

test('reverse cleanup covers lost acknowledgement and never removes a pre-existing or rebound pair',async()=>{
  const fixture=(initial?:string,lostAck=false)=>{
    let destination=initial;const removed:string[]=[];
    const reverse=new GotifyReverse(32123,async args=>{
      if(args[1]==='--list')return destination?`owned tcp:32123 ${destination}\n`:'';
      if(args[1]==='--no-rebind'){destination=args[3];if(lostAck)throw new Error('lost acknowledgement');return '';}
      if(args[1]==='--remove'){removed.push(args[2]);destination=undefined;return '';}
      throw new Error('Unexpected owned command');
    });
    return {reverse,removed,setDestination:(next:string)=>{destination=next;},get destination(){return destination;}};
  };
  const lost=fixture(undefined,true);await expect(lost.reverse.create()).rejects.toThrow('lost acknowledgement');
  expect(lost.destination).toBe('tcp:32123');await lost.reverse.cleanup();expect(lost.removed).toEqual(['tcp:32123']);expect(lost.destination).toBeUndefined();
  for(const initial of ['tcp:32123','tcp:45678']) {
    const foreign=fixture(initial);await expect(foreign.reverse.create()).rejects.toThrow();await foreign.reverse.cleanup();expect(foreign.removed).toEqual([]);expect(foreign.destination).toBe(initial);
  }
  const changed=fixture();await changed.reverse.create();changed.setDestination('tcp:45678');
  await expect(changed.reverse.cleanup()).rejects.toThrow();expect(changed.removed).toEqual([]);
});

test('installed APK proof binds actual package UID, one base path, bounded file and stable digest',async()=>{
  const hash='b'.repeat(64),name='app.lazysh.client',path=`/data/app/~~owned/${name}-owned/base.apk`;
  const fixture=(fault='')=>{
    let pathReads=0,uidReads=0,statReads=0;
    return (args:string[]):Promise<string>=>Promise.resolve((()=>{
      if(args[1]==='cmd')return `package:${name} uid:${fault==='uid'&&uidReads++>0?10236:10235}\n`;
      if(args[1]==='pm')return `package:${fault==='path'&&pathReads++>0?'/data/app/other/base.apk':path}\n${fault==='split'?'package:/data/app/other/split.apk\n':''}`;
      if(args[1]==='stat')return `${fault==='owner'?'10235':'1000'}:${fault==='symlink'?'a1a4':'81a4'}:${fault==='hardlink'?'2':'1'}:${fault==='size'?'536870913':'100'}:8:${fault==='inode'&&statReads++>0?'1235':'1234'}\n`;
      if(args[1]==='sha256sum')return `${fault==='digest'?'c'.repeat(64):hash}  ${path}\n`;
      throw new Error('Unexpected APK readback');
    })());
  };
  expect(await gotifyInstalledApk(fixture(),name,hash,10235)).toMatchObject({sha256:hash,uid:10235});
  for(const fault of ['uid','path','split','owner','symlink','hardlink','size','inode','digest'])
    await expect(gotifyInstalledApk(fixture(fault),name,hash,10235)).rejects.toThrow();
  await expect(gotifyInstalledApk(fixture(),name,hash,10236)).rejects.toThrow();
});

test('actual package cleanup preserves foreign arrivals, ambiguous installs and replaced identities',async()=>{
  const hash='b'.repeat(64),name='app.lazysh.client';
  type App={uid:number;hash:string;inode:number};
  const fixture=(mode='success')=>{
    const apps=new Map<string,App>(),removed:string[]=[];
    const entry=(path:string)=>[...apps].find(([name])=>path===`/data/app/~~owned/${name}-owned/base.apk`);
    const installed=new OwnedGotifyPackages(async args=>{
      if(args[0]==='install') {
        apps.set(name,{uid:10235,hash:mode==='arrival'?'c'.repeat(64):hash,inode:1234});
        if(mode==='arrival'||mode==='lost-ack')throw new Error('Install not acknowledged');
        return 'Performing Streamed Install\nSuccess\n';
      }
      if(args[0]==='uninstall'){removed.push(args[1]);apps.delete(args[1]);if(mode==='uninstall-lost-ack')throw new Error('Uninstall acknowledgement lost');return 'Success\n';}
      if(args[1]==='pm'&&args[2]==='list')return apps.has(args.at(-1)!)?`package:${args.at(-1)}\n`:'';
      if(args[1]==='pm'&&args[2]==='path')return apps.has(args[3])?`package:/data/app/~~owned/${args[3]}-owned/base.apk\n`:'';
      if(args[1]==='cmd'&&args[2]==='notification')return '';
      if(args[1]==='cmd'){const app=apps.get(args.at(-1)!);return app?`package:${args.at(-1)} uid:${app.uid}\n`:'';}
      if(args[1]==='stat'){const app=entry(args.at(-1)!)?.[1];if(!app)throw new Error('Missing APK');return `1000:81a4:1:100:8:${app.inode}\n`;}
      if(args[1]==='sha256sum'){const app=entry(args[2])?.[1];if(!app)throw new Error('Missing APK');return `${app.hash}  ${args[2]}\n`;}
      throw new Error('Unexpected package operation');
    });
    return {installed,apps,removed};
  };
  for(const mode of ['arrival','lost-ack']) {
    const f=fixture(mode);await expect(f.installed.install(name,'/owned/app.apk',hash)).rejects.toThrow('not acknowledged');
    expect(await f.installed.cleanup()).toEqual(['ambiguous-package']);expect(f.removed).toEqual([]);expect(f.apps.has(name)).toBe(true);
  }
  for(const replacement of [{uid:10236,hash,inode:1234},{uid:10235,hash:'c'.repeat(64),inode:1234},{uid:10235,hash,inode:1235}]) {
    const f=fixture();await f.installed.install(name,'/owned/app.apk',hash);f.apps.set(name,replacement);
    expect((await f.installed.cleanup()).length).toBe(1);expect(f.removed).toEqual([]);expect(f.apps.get(name)).toEqual(replacement);
  }
  const preexisting=fixture();preexisting.apps.set(name,{uid:10235,hash,inode:1234});
  await expect(preexisting.installed.install(name,'/owned/app.apk',hash)).rejects.toThrow();
  expect(await preexisting.installed.cleanup()).toEqual([]);expect(preexisting.removed).toEqual([]);expect(preexisting.apps.has(name)).toBe(true);
  const lostRemoval=fixture('uninstall-lost-ack');await lostRemoval.installed.install(name,'/owned/app.apk',hash);
  expect(await lostRemoval.installed.cleanup()).toEqual([]);expect(lostRemoval.removed).toEqual([name]);expect(lostRemoval.apps.size).toBe(0);
  const owned=fixture();await owned.installed.install(name,'/owned/app.apk',hash);
  expect(await owned.installed.cleanup()).toEqual([]);expect(owned.removed).toEqual([name]);expect(owned.apps.size).toBe(0);
  const gradle=fixture();await gradle.installed.admitGradle();gradle.apps.set('app.lazysh.client.test',{uid:10237,hash,inode:1238});
  expect(await gradle.installed.cleanup()).toEqual(['ambiguous-package']);expect(gradle.removed).toEqual([]);
  const running=fixture();await running.installed.install(name,'/owned/app.apk',hash);await running.installed.admitGradle();
  running.apps.set(name,{uid:10235,hash,inode:1236});running.apps.set('app.lazysh.client.test',{uid:10237,hash,inode:1238});
  await running.installed.bindRunningArtifacts(hash);
  expect(await running.installed.cleanup()).toEqual([]);expect(running.removed).toEqual(['app.lazysh.client.test',name]);
});

test('Gotify CI routes the current app build to one isolated owned API36 case and finite artifacts',async()=>{
  const root=resolve(import.meta.dir,'..');
  const workflow=Bun.YAML.parse(await readFile(join(root,'.github/workflows/checks.yml'),'utf8')) as {jobs:Record<string,any>};
  const job=workflow.jobs['native-android-gotify'];
  expect([job['runs-on'],job['timeout-minutes'],job.env.ANDROID_SERIAL]).toEqual(['ubuntu-24.04',35,'emulator-5580']);
  const prerequisite=job.steps.findIndex((step:any)=>step.name==='Install owned Gotify fixture prerequisites');
  expect(prerequisite).toBeGreaterThan(job.steps.findIndex((step:any)=>step.run==='bun install --frozen-lockfile'));
  expect(prerequisite).toBeLessThan(job.steps.findIndex((step:any)=>step.uses==='android-actions/setup-android@v4'));
  expect(job.steps.some((step:any)=>step.env?.LAZYSH_NATIVE_NAMESPACE_NETWORK!==undefined||/\bbwrap\b/.test(step.run??''))).toBe(false);
  const runtime=job.steps.find((step:any)=>step.name==='Official Gotify Android background delivery');
  expect(runtime.uses).toBe('mihazs/lazysh-android-emulator-runner@46beb5d59b664ea61462125a023549a5a7b0418b');
  expect(runtime.with).toMatchObject({'api-level':36,target:'default',arch:'x86_64','avd-name':'lazysh-runtime-api36','emulator-port':5580,'unlock-screen':false,'disable-linux-hw-accel':false});
  expect(runtime.with['emulator-options']).toContain('theme-qr-camera-feed.png');
  expect(runtime.with['emulator-options']).toContain('lazysh-gotify-emulator.pid');
  const script=runtime.with.script as string;
  for(const key of ['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'])expect(script).toContain(`-u ${key}`);
  expect(script).toStartWith('env -u ');expect(script.trim().split('\n')).toHaveLength(1);
  expect(script).toContain('LAZYSH_ANDROID_QR_EMULATOR_PID_FILE="$RUNNER_TEMP/lazysh-gotify-emulator.pid" bun run test:android-gotify');
  expect(job.steps.some((step:any)=>step.run==='test -c /dev/kvm\nsudo chown "$(id -u):$(id -g)" /dev/kvm\nsudo chmod 0600 /dev/kvm\n')).toBe(true);
  const uploads=job.steps.filter((step:any)=>step.uses==='actions/upload-artifact@v4');
  expect(uploads).toHaveLength(1);expect(uploads[0].if).toBe('always()');
  expect(uploads[0].with).toMatchObject({name:'lazysh-gotify-acceptance',path:'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results/gotify/*.json'});
  expect(workflow.jobs['native-android-ntfy'].strategy.matrix['push-variant']).toEqual(['fdroid','google']);
  const rootPackage=JSON.parse(await readFile(join(root,'package.json'),'utf8')),client=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8'));
  expect(rootPackage.scripts['test:ci']).toContain('./tests/android-gotify.test.ts');
  expect(rootPackage.scripts['test:android-gotify']).toBe('turbo run test:android-gotify --filter=@lazysh/client');
  expect(client.scripts['test:android-gotify']).toContain('cargo build --locked --jobs 2 -p lazysh-notifications --example owned_gotify_android --features test-support');
  expect(client.scripts['test:android-gotify']).toContain('LAZYSH_ANDROID_GOTIFY=1 bun test ../../tests/android-gotify.test.ts');
  const turbo=JSON.parse(await readFile(join(root,'turbo.json'),'utf8')).tasks;
  expect(turbo['test:android-gotify']).toMatchObject({cache:false,dependsOn:['build:android:emulator']});
  for(const key of ['GITHUB_ACTIONS','ANDROID_SERIAL','LAZYSH_ANDROID_QR_EMULATOR_PID_FILE'])expect(turbo['test:android-gotify'].passThroughEnv).toContain(key);
});

test('proxy admission failure retains only a finite failure artifact without target access',async()=>{
  const root=await mkdtemp(join(tmpdir(),'.lazysh-gotify-finite-'));
  const script=`import {ownedGotifyAndroid} from ${JSON.stringify(resolve(import.meta.dir,'support/androidGotify.ts'))};
    try{await ownedGotifyAndroid(process.env.FAKE_ROOT);process.exit(1);}catch(error){process.exit(error.message==='Owned Gotify fixture requires a proxy-free child environment'?0:1);}`;
  const child=new OwnedProcess(process.execPath,['-e',script],undefined,{...process.env,HTTP_PROXY:'http://127.0.0.1:9',FAKE_ROOT:root});
  try {
    await child.finish('finite proxy admission failure',2000);
    const path=join(root,'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results/gotify');
    const {readdir}=await import('node:fs/promises');expect(await readdir(path)).toEqual(['failure.json']);
    const receipt=JSON.parse(await readFile(join(path,'failure.json'),'utf8'));
    expect(receipt).toEqual({schemaVersion:1,scope:'official-gotify-awake-background',phase:'fixture',runtimePassed:false,notificationDelivery:false,cleanup:'unverified'});
    expect(JSON.stringify(receipt)).not.toMatch(/127\.0\.0\.1|http:|FAKE_ROOT|token|password|stack/);
  }finally{await child.stop();await rm(root,{recursive:true,force:true});}
});

test.skipIf(process.env.LAZYSH_ANDROID_GOTIFY!=='1')('official Gotify displays all finite events on an owned awake API36 background client',async()=>{
  const receipt=await ownedGotifyAndroid(resolve(import.meta.dir,'..'));
  expect(receipt).toMatchObject({relayAccepted:3,serverMessages:3,osRecords:3,visibleCards:3,history:true,cleanup:true,native:{passed:1,failed:0,skipped:0}});
  console.log('Owned Gotify Android receipt '+JSON.stringify(receipt));
},480000);
