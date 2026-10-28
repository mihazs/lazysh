import {expect,test} from 'bun:test';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,delimiter} from 'node:path';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const variant=process.env.LAZYSH_ANDROID_PUSH_VARIANT;
const client=resolve(import.meta.dir,'../apps/client');
const android=join(client,'src-tauri/gen/android');

test.skipIf(!variant)('actual Android push dependencies, manifest and dex match the selected distribution',async()=>{
  expect(['google','fdroid']).toContain(variant);
  const google=variant==='google';
  const sdk=process.env.ANDROID_HOME;
  expect(sdk).toBeTruthy();
  const configuration=process.env.LAZYSH_ANDROID_PUSH_CONFIGURATION??'universalDebugRuntimeClasspath';
  expect(configuration).toMatch(/^universal(Debug|Release)RuntimeClasspath$/);
  const release=configuration.includes('Release');
  const apk=process.env.LAZYSH_ANDROID_PUSH_APK??join(android,'app/build/outputs/apk/universal/debug/app-universal-debug.apk');
  const env={...process.env,PATH:[process.env.JAVA_HOME&&join(process.env.JAVA_HOME,'bin'),process.env.PATH].filter(Boolean).join(delimiter)};
  const run=async(program:string,args:string[])=>
    (await execute(program,args,{cwd:android,env,timeout:180_000,maxBuffer:32*1024*1024})).stdout;
  const analyzer=join(sdk!,'cmdline-tools/latest/bin/apkanalyzer');
  const graph=await run(join(android,'gradlew'),[':app:dependencies','--configuration',configuration,'--no-daemon',
    '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64']);
  const manifest=await run(analyzer,['manifest','print',apk]);
  const dex=await run(analyzer,['dex','packages','--defined-only',apk]);
  const applicationId=(await run(analyzer,['manifest','application-id',apk])).trim();
  const versionName=(await run(analyzer,['manifest','version-name',apk])).trim();
  const versionCode=Number((await run(analyzer,['manifest','version-code',apk])).trim());
  const debuggable=(await run(analyzer,['manifest','debuggable',apk])).trim();
  const version=JSON.parse(await readFile(join(client,'package.json'),'utf8')).version as string;
  const [major,minor,patch]=version.split('.').map(Number);
  expect(applicationId).toBe('app.lazysh.client');
  expect(versionName).toBe(version);
  expect(versionCode).toBe(major*1_000_000+minor*1_000+patch);
  expect(debuggable).toBe(String(!release));
  const observed={
    nativeProject:/\bproject '?\:tauri-plugin-lazysh-push'?/.test(graph),
    firebaseDependency:graph.includes('com.google.firebase:firebase-messaging:'),
    playDependency:graph.includes('com.google.android.gms:play-services-base:'),
    firebaseClasses:/\bcom\.google\.firebase\b/.test(dex),
    playClasses:/\bcom\.google\.android\.gms\b/.test(dex),
    pushService:manifest.includes('app.lazysh.push.PushMessagingService'),
    firebaseManifest:manifest.includes('com.google.firebase'),
    googleMessagingPermission:manifest.includes('com.google.android.c2dm.permission.RECEIVE'),
  };
  const receipt={variant,configuration,applicationId,versionName,versionCode,debuggable,
    sha256:createHash('sha256').update(await readFile(apk)).digest('hex'),observed};
  const directory=join(android,'app/build/outputs/androidTest-results/push-artifact');
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`${variant}.json`),JSON.stringify(receipt,null,2)+'\n');
  for(const [field,present] of Object.entries(observed))expect(present,field).toBe(google);
},300_000);
