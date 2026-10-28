import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {OwnedNtfyPackages,ntfyEnvironment,inspectAcceptanceTrust,realNtfyChallenge} from './support/androidNtfy';
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
