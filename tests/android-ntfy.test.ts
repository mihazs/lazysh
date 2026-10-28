import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {OwnedNtfyPackages,ntfyEnvironment,distributorHasGooglePush,inspectAcceptanceTrust,realNtfyChallenge} from './support/androidNtfy';
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
