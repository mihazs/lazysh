import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {publishedAcceptance,publishedInstrumentation,publishedOutput,publishedState,translatedGuest,type PublishedCommand} from './support/androidPublished';

const nonce='a'.repeat(32),component='app.lazysh.acceptance/androidx.test.runner.AndroidJUnitRunner';
const output=(phase:string)=>`INSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS: lazyshPublishedPhase=${phase}\nINSTRUMENTATION_STATUS: lazyshPublishedPassed=true\nINSTRUMENTATION_STATUS_CODE: 0\nINSTRUMENTATION_CODE: -1`;
const env={ANDROID_HOME:'/sdk',ANDROID_SERIAL:'emulator-5580'};
const admitted=async()=>({check:async()=>{}});
async function fixture(check:(asset:any)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'lazysh-published-owner-'));
  const apk=join(root,'public.apk'),bytes=Buffer.from('owned-synthetic-public-apk');await writeFile(apk,bytes);
  try{await check({apk,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sha:'b'.repeat(40),version:'0.23.0',tag:'v0.23.0',flavor:'foss',certificateSha256:'c'.repeat(64)});}finally{await rm(root,{recursive:true,force:true});}
}
function fake(changes:(args:string[])=>string|undefined=()=>undefined){
  const calls:string[][]=[];
  const run:PublishedCommand=async(_program,args)=>{
    calls.push(args);const selected=changes(args);if(selected!==undefined)return selected;
    if(args.includes('getprop'))return ({'ro.build.version.sdk':'35','ro.product.cpu.abilist':'x86_64,arm64-v8a','ro.dalvik.vm.native.bridge':'libndk_translation.so','ro.dalvik.vm.isa.arm64':'x86_64','ro.build.fingerprint':'owned-synthetic-google-image'} as Record<string,string>)[args.at(-1)!]??'';
    if(args.includes('/proc/sys/kernel/random/boot_id'))return '00000000-1111-2222-3333-444444444444';
    if(args.includes('instrumentation'))return `instrumentation:${component} (target=app.lazysh.acceptance)`;
    if(args.includes('instrument'))return output(args[args.indexOf('phase')+1]);
    return '';
  };return {calls,run};
}
test('translation admission requires the reviewed API, ARM64 ABI, bridge and ISA mapping',()=>{
  const values=['35','x86_64,arm64-v8a','libndk_translation.so','x86_64'];expect(translatedGuest(values)).toBe(true);
  for(let i=0;i<values.length;i++)expect(translatedGuest(values.map((value,index)=>i===index?'private-unrecognized-value':value))).toBe(false);
});
test('one complete phase result is required; skips, crashes, wrong phase and private failure data fail closed',()=>{
  expect(publishedInstrumentation(output('create'),'create')).toBe(true);
  for(const text of [output('verify'),output('create').replace('numtests=1','numtests=0'),output('create')+'\nINSTRUMENTATION_STATUS: numtests=2',output('create')+'\nINSTRUMENTATION_STATUS_CODE: -2',output('create')+'\nINSTRUMENTATION_RESULT: shortMsg=private-message',output('create')+'\nINSTRUMENTATION_CODE: -1','x'.repeat(65537),'private-message'])expect(publishedInstrumentation(text,'create')).toBe(false);
});
test('identical nominated bytes survive normal UI create, process relaunch and install-r before owned cleanup',()=>fixture(async asset=>{
  const f=fake(),result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.passed).toBe(true);expect(result.receipt).toMatchObject({created:true,relaunched:true,reinstalled:true,preserved:true,cleanup:'passed',scope:'translated-arm64'});
  expect(f.calls.filter(args=>args.includes('install'))).toEqual([
    ['-s','emulator-5580','install',asset.apk],['-s','emulator-5580','install','-t','/owned/driver.apk'],['-s','emulator-5580','install','-r',asset.apk],
  ]);
  expect(f.calls.filter(args=>args.includes('instrument')).map(args=>args[args.indexOf('phase')+1])).toEqual(['create','verify','verify']);
  expect(f.calls.slice(-2).map(args=>args.slice(2))).toEqual([['uninstall','app.lazysh.acceptance'],['uninstall','app.lazysh.client']]);
  expect(JSON.stringify(result)).not.toContain(asset.apk);expect(JSON.stringify(result)).not.toContain(nonce);expect(JSON.stringify(result)).not.toContain('owned-synthetic-google-image');
}));
test.each(['app.lazysh.client','app.lazysh.acceptance'])('preexisting %s is neither adopted nor removed',name=>fixture(async asset=>{
  const f=fake(args=>args.includes('packages')&&args.at(-1)===name?`package:${name}`:undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.receipt.failureStage).toBe('package-absence');expect(result.passed).toBe(false);
  expect(f.calls.some(args=>args.includes('install')||args.includes('uninstall'))).toBe(false);
}));
test('driver-install failure releases only confirmed owned application and marks uncertain driver cleanup',()=>fixture(async asset=>{
  const f=fake(),run:PublishedCommand=async(program,args,wait)=>{if(args.includes('install')&&args.includes('-t'))throw new Error('private-driver-failure');return f.run(program,args,wait);};
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,run,admitted);
  expect(result.receipt).toMatchObject({failureStage:'driver-install',cleanup:'unconfirmed'});
  expect(f.calls.filter(args=>args.includes('uninstall')).map(args=>args.at(-1))).toEqual(['app.lazysh.client']);
  expect(JSON.stringify(result)).not.toContain('private-driver-failure');
}));
test('original UI failure and cleanup failure are retained separately without private data',()=>fixture(async asset=>{
  const f=fake(),run:PublishedCommand=async(program,args,wait)=>{
    if(args.includes('instrument')||args.includes('uninstall'))throw new Error('private-error-and-path');
    return f.run(program,args,wait);
  };
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,run,admitted);
  expect(result.receipt).toMatchObject({failureStage:'create',cleanup:'failed',created:false});
  expect(result.passed).toBe(false);expect(JSON.stringify(result)).not.toContain('private-error');
}));
test('APK changed after independent verification never installs',()=>fixture(async asset=>{
  await writeFile(asset.apk,'changed-public-fixture');const f=fake();
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.receipt.failureStage).toBe('asset-continuity');expect(f.calls.some(args=>args.includes('install'))).toBe(false);
}));
test('foreign device and failed process attestation never invoke adb',()=>fixture(async asset=>{
  let calls=0;const run:PublishedCommand=async()=>{calls++;return '';};
  await expect(publishedAcceptance(asset,'/driver',nonce,{...env,ANDROID_SERIAL:'personal-device'},run,admitted)).rejects.toThrow('admission');
  await expect(publishedAcceptance(asset,'/driver',nonce,env,run,async()=>{throw new Error('owned process rejected');})).rejects.toThrow('owned process rejected');
  expect(calls).toBe(0);
}));
test.skipIf(process.platform!=='linux')('real owned output rejects overflow/error/timeout without retaining private child output',async()=>{
  expect(await publishedOutput(process.execPath,['-e',"process.stdout.write('complete')"],1000)).toBe('complete');
  for(const script of ["process.stdout.write('x'.repeat(65537))","process.stderr.write('private-child');process.exit(9)","setTimeout(()=>{},10000)"]){
    const error=await publishedOutput(process.execPath,['-e',script],100).catch(error=>error as Error);
    expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('private-child');
  }
});

test('private state permits only finite nominated fields and the exact owned asset path',()=>{
  const base='/owned',state={apk:'/owned/assets/lazysh-0.23.0-android-foss-arm64.apk',bytes:12,certificateSha256:'c'.repeat(64),flavor:'foss',nonce,sha:'b'.repeat(40),sha256:'d'.repeat(64),tag:'v0.23.0',version:'0.23.0'};
  expect(publishedState(state,base)).toBe(true);
  for(const patch of [{flavor:'../private'},{apk:'/private/foreign.apk'},{message:'private-error'},{nonce:'x'.repeat(33)},{bytes:Infinity},{tag:'v0.24.0'},{sha:null}])expect(publishedState({...state,...patch},base)).toBe(false);
});
