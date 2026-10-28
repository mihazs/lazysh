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
  const files=await run(analyzer,['files','list',apk]);
  const trustPath=(await run(analyzer,['resources','value','--config','default','--name','network_security_config','--type','xml',apk])).trim();
  expect(trustPath).toMatch(/^res\/[A-Za-z0-9_/.]+\.xml$/);
  const trust=await run(analyzer,['resources','xml','--file',`/${trustPath}`,apk]);
  const acceptanceTrustAbsent=!files.includes('lazysh_unifiedpush_test_ca') && !trust.includes('debug-overrides');
  let rejected:unknown;
  try {
    await run(join(android,'gradlew'),[google?':app:assembleUniversalDebug':':app:assembleUniversalRelease','--dry-run','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64',`-PlazyshUnifiedPushAcceptanceCa=${apk}`]);
  } catch(error){rejected=error;}
  const failure=rejected as {stdout?:string;stderr?:string}|undefined;
  const guardReason=google?'UnifiedPush acceptance trust requires the F-Droid native provider':'UnifiedPush acceptance trust requires an explicit debug acceptance task';
  const unsafeAcceptanceTaskRejected=Boolean(failure&&`${failure.stdout??''}${failure.stderr??''}`.includes(guardReason));
  expect(unsafeAcceptanceTaskRejected).toBe(true);
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
    unifiedDependency:graph.includes('org.unifiedpush.android:connector:3.3.5'),
    unifiedClasses:/\borg\.unifiedpush\.android\.connector\b/.test(dex),
    unifiedService:manifest.includes('app.lazysh.unifiedpush.RegistrationService'),
    androidCrypto:graph.includes('com.google.crypto.tink:tink-android:1.23.0'),
    serverCrypto:graph.includes('com.google.crypto.tink:tink:'),
    embeddedFcm:/\borg\.unifiedpush\.android\.(?:foss_)?embedded_fcm_distributor\b/.test(dex),
  };
  const enrollment=google?null:{
    pinnedHttp:graph.includes('com.squareup.okhttp3:okhttp:5.5.1'),
    nativeHttp:release?null:/\bapp\.lazysh\.unifiedpush\.EnrollmentHttp\b/.test(dex),
    privateStorage:release?null:/\bapp\.lazysh\.unifiedpush\.PrivateEnrollmentStore\b/.test(dex),
  };
  const receipt={variant,configuration,applicationId,versionName,versionCode,debuggable,enrollment,acceptanceTrustAbsent,unsafeAcceptanceTaskRejected,
    sha256:createHash('sha256').update(await readFile(apk)).digest('hex'),observed};
  const directory=join(android,'app/build/outputs/androidTest-results/push-artifact');
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`${variant}.json`),JSON.stringify(receipt,null,2)+'\n');
  expect(acceptanceTrustAbsent).toBe(true);
  expect(observed).toEqual({
    nativeProject:true,firebaseDependency:google,playDependency:google,firebaseClasses:google,
    playClasses:google,pushService:google,firebaseManifest:google,googleMessagingPermission:google,
    unifiedDependency:!google,unifiedClasses:!google,unifiedService:!google,androidCrypto:!google,
    serverCrypto:false,embeddedFcm:false,
  });
  if(!google){
    expect(enrollment?.pinnedHttp).toBe(true);
    if(!release){ expect(enrollment?.nativeHttp).toBe(true); expect(enrollment?.privateStorage).toBe(true); }
    const service=manifest.match(/<service\b[^>]*>/g)?.find(tag=>tag.includes('"app.lazysh.unifiedpush.RegistrationService"'));
    expect(service).toMatch(/android:exported="false"/);
    expect(manifest).toContain('org.unifiedpush.android.connector.internal.MessagingReceiverImpl');
  }
},300_000);
