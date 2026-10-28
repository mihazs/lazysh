import {expect,test,spyOn} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm,stat,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {OwnedNtfyPackages,ntfyEnvironment,distributorHasGooglePush,inspectAcceptanceTrust,realNtfyChallenge,realNtfyStartup,relayInput,ntfyHealth,privateInputCommand,writePrivateInput} from './support/androidNtfy';
import {OwnedProcess} from './support/androidSsh';

test.skipIf(!process.env.LAZYSH_NTFY_TRUST_CA)('actual fixture APK contains only its explicitly selected debug CA',async()=>{
  const sdk=process.env.ANDROID_HOME;
  expect(sdk).toBeTruthy();
  await inspectAcceptanceTrust(resolve(import.meta.dir,'../apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk'),
    process.env.LAZYSH_NTFY_TRUST_CA!,sdk!,async(stage,program,args)=>new OwnedProcess(program,args).finish(stage,60_000));
});

test('owned ntfy cannot inherit operator server, proxy or provider credentials',()=>{
  expect(ntfyEnvironment({PATH:'/tools',HOME:'/original-home',LANG:'C.UTF-8',NTFY_BASE_URL:'https://personal.invalid',
    NTFY_AUTH_FILE:'/personal/store',NTFY_FIREBASE_KEY_FILE:'/personal/key',HTTP_PROXY:'https://proxy.invalid',
    TOKEN:'private-provider-token'})).toEqual({PATH:'/tools',HOME:'/original-home',LANG:'C.UTF-8'});
});

test('private transfer creates an absent owned directory, rejects symlinks and cannot replace a receipt',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'.lazysh-private-transfer-'));
  const nonce='a'.repeat(32),input=Buffer.from('synthetic-private-fixture');
  const target=join(directory,`files/.lazysh-ntfy-${nonce}.json`);
  const transfer=async()=>{
    const child=new OwnedProcess('sh',['-c',privateInputCommand(nonce)],directory);
    await writePrivateInput(Buffer.from(input),child.child.stdin!,()=>child.finish('owned private transfer',5000));
  };
  try{
    await transfer();expect(await readFile(target)).toEqual(input);
    expect((await stat(join(directory,'files'))).mode&0o777).toBe(0o700);
    expect((await stat(target)).mode&0o777).toBe(0o600);
    await expect(transfer()).rejects.toThrow('Owned fixture failed');
    expect(await readFile(target)).toEqual(input);
    await rm(join(directory,'files'),{recursive:true});
    const outside=join(directory,'outside');await mkdir(outside);await symlink(outside,join(directory,'files'));
    await expect(transfer()).rejects.toThrow('Owned fixture failed');
    expect(await readFile(join(outside,`.lazysh-ntfy-${nonce}.json`)).catch(error=>error.code)).toBe('ENOENT');
    expect(()=>privateInputCommand("invalid'; payload")).toThrow('admission failed');
  }finally{input.fill(0);await rm(directory,{recursive:true,force:true});}
});

test('private stdin bytes survive pending transmission and are erased after success or failure settles',async()=>{
  for(const fail of [false,true]){
    const input=Buffer.from('synthetic-asynchronous-input'),sink=new PassThrough();
    let settle!:(value?:unknown)=>void;
    const finished=new Promise<void>((resolve,reject)=>{settle=fail?reject:()=>resolve();});
    const pending=writePrivateInput(input,sink,()=>finished);
    const result=pending.then(()=>({ok:true,message:null}),error=>({ok:false,message:error.message}));
    try{
      expect(input.toString()).toBe('synthetic-asynchronous-input');
      expect(sink.read()).toEqual(Buffer.from('synthetic-asynchronous-input'));
      settle(fail?new Error('synthetic failure'):undefined);
      expect(await result).toEqual({ok:!fail,message:fail?'synthetic failure':null});
      expect(input.every(byte=>byte===0)).toBe(true);
    }finally{settle(fail?new Error('synthetic failure'):undefined);await result;sink.destroy();}
  }
});

test('asynchronous stdin EPIPE waits for teardown, preserves the primary failure and redacts stream errors',async()=>{
  for(const primaryFailure of [false,true]){
    const input=Buffer.from('synthetic-pending-input');
    let release!:()=>void;
    const teardown=new Promise<void>(resolve=>{release=resolve;});
    let wrote!:()=>void;
    const errored=new Promise<void>(resolve=>{wrote=resolve;});
    const sink=new Writable({write(_chunk,_encoding,callback){queueMicrotask(()=>{callback(Object.assign(new Error('private-pipe-error'),{code:'EPIPE'}));wrote();});}});
    const pending=writePrivateInput(input,sink,async()=>{await teardown;if(primaryFailure)throw new Error('original transfer failure');});
    const result=pending.then(()=>'',error=>error.message);
    try{
      await errored;expect(input.toString()).toBe('synthetic-pending-input');
      release();expect(await result).toBe(primaryFailure?'original transfer failure':'Private fixture input could not be transmitted');
      expect(input.every(byte=>byte===0)).toBe(true);
    }finally{release();await result;sink.destroy();}
  }
});

test('ready relay input cannot outlive a held ownership check or completed child',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'.lazysh-relay-deadline-'));
  const child=new OwnedProcess('cat',[]);
  const clock=spyOn(performance,'now').mockReturnValue(0);
  try{
    await writeFile(join(directory,'input.json'),'{}');
    expect(await child.liveIdentity()).toBeTruthy();
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const pending=relayInput(child,directory,()=>held);
    clock.mockReturnValue(120_001);release();
    await expect(pending).rejects.toThrow('Owned native relay readiness deadline');
    clock.mockReturnValue(0);
    child.child.stdin!.end();await child.done;
    await expect(relayInput(child,directory,async()=>{})).rejects.toThrow('Owned native relay readiness deadline');
  }finally{clock.mockRestore();await child.stop();await rm(directory,{recursive:true,force:true});}
});

test('signalled ntfy is classified as stopped without a live or private-error receipt',async()=>{
  const child=new OwnedProcess('cat',[]);
  const messages:string[]=[];
  const logger=spyOn(console,'error').mockImplementation(value=>{messages.push(String(value));});
  const clock=spyOn(performance,'now').mockReturnValue(0);
  try{
    await child.stop();
    expect(child.child.signalCode).toBe('SIGTERM');
    await expect(ntfyHealth(child,'https://localhost:1','/owned/private',async()=>{clock.mockReturnValue(10_001);throw new Error('private-payload');})).rejects.toThrow('Owned ntfy startup was signalled');
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual({ntfyStartupExit:null,ntfyStartupSignal:'terminated',cliRejected:false,
      configurationRejected:false,tlsRejected:false,listenerRejected:false,storageRejected:false});
  }finally{clock.mockRestore();logger.mockRestore();await child.stop();}
});

test('only the pinned distributor inert action and icon tags are exempt from manifest namespace rejection',()=>{
  const action='<action android:name="com.google.firebase.MESSAGING_EVENT" />';
  const icon='<meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@ref/0x7f0800b3" />';
  expect(distributorHasGooglePush(action+icon,true)).toBe(false);
  for(const tag of ['service','receiver','uses-permission'])expect(distributorHasGooglePush(action.replace('action',tag),true)).toBe(true);
  expect(distributorHasGooglePush(action.replace(' />',' android:exported="true" />'),true)).toBe(true);
  expect(distributorHasGooglePush(icon.replace('resource=','value='),true)).toBe(true);
  for(const namespace of ['com.google.firebase.messaging.FirebaseMessagingService','com.google.android.gms','com.google.android.c2dm.permission.RECEIVE','org.unifiedpush.android.embedded_fcm_distributor']){
    expect(distributorHasGooglePush(namespace)).toBe(true);
    expect(distributorHasGooglePush(action+icon+namespace,true)).toBe(true);
  }
  expect(distributorHasGooglePush(action)).toBe(true);
});

test.skipIf(!process.env.LAZYSH_NTFY_DISTRIBUTOR_APK)('actual pinned official FOSS distributor has no Google push classes or active manifest component',async()=>{
  const apk=process.env.LAZYSH_NTFY_DISTRIBUTOR_APK!;
  const pins=JSON.parse(await readFile(resolve(import.meta.dir,'../apps/client/src-tauri/fixtures/ntfy-provenance.json'),'utf8'));
  const {createHash}=await import('node:crypto');
  expect(createHash('sha256').update(await readFile(apk)).digest('hex')).toBe(pins.android.sha256);
  const analyzer=resolve(process.env.ANDROID_HOME!,'cmdline-tools/latest/bin/apkanalyzer');
  for(const [command,manifest] of [[['manifest','print'],true],[['dex','packages','--defined-only'],false]] as const){
    const child=new OwnedProcess(analyzer,[...command,apk]);
    const chunks:Buffer[]=[];let size=0;
    child.child.stdout!.on('data',(bytes:Buffer)=>{size+=bytes.length;if(size<=32*1024*1024)chunks.push(bytes);else void child.stop().catch(()=>{});});
    await child.finish('official distributor namespace oracle',60_000);
    expect(size).toBeGreaterThan(0);expect(size).toBeLessThanOrEqual(32*1024*1024);
    expect(distributorHasGooglePush(Buffer.concat(chunks).toString('utf8'),manifest)).toBe(false);
  }
});

test('a remote install with a lost acknowledgement still removes the exact owned package',async()=>{
  const remote=new Set<string>();
  const failure=new Error('synthetic lost acknowledgement');
  const calls:string[][]=[];
  const owned=new OwnedNtfyPackages(async args=>{
    calls.push(args);
    if(args[0]==='install'){remote.add('io.heckel.ntfy');throw failure;}
    if(args[0]==='shell')return [...remote].filter(name=>name===args.at(-1)).map(name=>`package:${name}`).join('\n');
    if(args[0]==='uninstall'){remote.delete(args[1]);return 'Success';}
    throw new Error('Unexpected package action');
  });
  await expect(owned.install('io.heckel.ntfy','/owned/distributor.apk')).rejects.toBe(failure);
  expect(await owned.cleanup()).toEqual([]);
  expect(remote.size).toBe(0);
  expect(calls.at(-1)).toEqual(['uninstall','io.heckel.ntfy']);
});

test('real ntfy pins identify the official FOSS distributor and immutable server archive',async()=>{
  const pins=JSON.parse(await readFile(resolve(import.meta.dir,'../apps/client/src-tauri/fixtures/ntfy-provenance.json'),'utf8'));
  expect(pins.schemaVersion).toBe(1);
  expect(pins.android.url).toMatch(/^https:\/\/github\.com\/binwiederhier\/ntfy-android\/releases\/download\/v[\d.]+\/ntfy-[\d.]+-fdroid-release\.apk$/);
  expect(pins.server.url).toMatch(/^https:\/\/github\.com\/binwiederhier\/ntfy\/releases\/download\/v[\d.]+\/ntfy_[\d.]+_linux_amd64\.tar\.gz$/);
  for(const value of [pins.android.sha256,pins.android.signerSha256,pins.server.sha256])expect(value).toMatch(/^[a-f\d]{64}$/);
  expect(pins.android.applicationId).toBe('io.heckel.ntfy');
});

test.skipIf(process.env.LAZYSH_ANDROID_NTFY!=='1')('actual official ntfy encrypted native challenge and authenticated pause',async()=>{
  await realNtfyChallenge();
},900_000);

test.skipIf(!process.env.LAZYSH_NTFY_SERVER_ARCHIVE)('official owned ntfy starts HTTPS with the actual native relay configuration',async()=>{
  await realNtfyStartup(process.env.LAZYSH_NTFY_SERVER_ARCHIVE!);
},150_000);
