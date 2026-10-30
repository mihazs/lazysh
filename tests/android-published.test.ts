import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {publishedAcceptance,publishedInstrumentation,publishedOutput,publishedState,publishedDriverStage,publishedDriverObservation,publishedCommandFailure,publishedCommandProgress,publishedDriverProgress,publishedCliFailure,translatedGuest,type PublishedCommand} from './support/androidPublished';
import {preparePublishedApk} from './support/androidPublishedAssets';
import {identity} from './support/ownedProcess';

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
  expect(result.receipt.driverCommand.outcome).toBe('completed');
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
  expect(result.receipt.driverCommand).toEqual({outcome:'unavailable',elapsedMs:null});
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
  for(const [script,category] of [["process.stdout.write('x'.repeat(65537))",'output-bound'],["process.stderr.write('private-child');process.exit(9)",'nonzero'],["setTimeout(()=>{},10000)",'deadline']]){
    const error=await publishedOutput(process.execPath,['-e',script],100).catch(error=>error as Error);
    expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('private-child');
    expect(publishedCommandFailure(error)).toBe(category);
  }
  expect(publishedCommandFailure(await publishedOutput('/owned/not-installed-published-tool',[],100).catch(error=>error))).toBe('start');
});
test('closed host failure projection rejects private, partial, forged and unknown labels',async()=>{
  expect(publishedCommandFailure(new Error('Owned fixture process teardown deadline'))).toBe('teardown');
  expect(publishedCommandFailure(new Error('Owned fixture failed: published APK command; exit=255'))).toBe('nonzero');
  const poison=new Error();Object.defineProperty(poison,'message',{get(){throw new Error('private-getter');}});
  for(const error of [null,{message:'Owned fixture process could not start'},poison,new Error('private-path'),
    new Error('Owned fixture deadline: published APK command private'),new Error('Owned fixture failed: published APK command; exit=0'),
    new Error('Owned fixture failed: published APK command; exit=256'),new Error('Owned fixture failed: published APK command; exit=01'),
    new Error('Owned fixture failed: published APK command; exit=9\nprivate-stderr')]){
    expect(publishedCommandFailure(error)).toBe('unavailable');expect(publishedCliFailure(error)).toBe('unavailable');
  }
  expect(publishedCliFailure(new Error('Published APK requires an absent fresh AVD'))).toBe('avd-present');
  expect(publishedCliFailure(new Error('Published APK environment required'))).toBe('environment');
  expect(publishedCliFailure(new Error('Published APK environment required /private/path'))).toBe('unavailable');
  const assetError=await preparePublishedApk('not-a-tag','foss','/owned/unused','c'.repeat(64)).catch(error=>error);
  assetError.message='private-response';expect(publishedCliFailure(assetError)).toBe('asset:invocation');
});
test.each(['deadline','nonzero','start','teardown','output-bound'] as const)('driver command %s remains separate from original phase and cleanup failure',category=>fixture(async asset=>{
  const labels={deadline:'Owned fixture deadline: published APK command',nonzero:'Owned fixture failed: published APK command; exit=7',
    start:'Owned fixture process could not start',teardown:'Owned fixture process teardown deadline','output-bound':'Published APK output exceeded bound'};
  const f=fake(args=>{if(args.includes('instrument'))throw new Error(labels[category]);if(args.includes('uninstall'))throw new Error('private-cleanup');return undefined;});
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.passed).toBe(false);expect(result.receipt).toMatchObject({failureStage:'create',driverStage:'unavailable',cleanup:'failed',driverCommand:{outcome:category}});
  expect(Number.isInteger(result.receipt.driverCommand.elapsedMs)).toBe(true);
  expect(result.receipt.driverCommand.elapsedMs).toBeGreaterThanOrEqual(0);expect(result.receipt.driverCommand.elapsedMs).toBeLessThanOrEqual(60000);
  expect(JSON.stringify(result)).not.toContain('private-cleanup');
}));
test('completed command with unclassified instrumentation is not guessed to be a crash or timeout',()=>fixture(async asset=>{
  const f=fake(args=>args.includes('instrument')?'private-unclassified-output':undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.receipt).toMatchObject({failureStage:'create',driverStage:'unavailable',driverObservation:{state:'unavailable'},driverCommand:{outcome:'completed'},cleanup:'passed'});
  expect(result.passed).toBe(false);expect(JSON.stringify(result)).not.toContain('private-unclassified-output');
}));

test('private state permits only finite nominated fields and the exact owned asset path',()=>{
  const base='/owned',state={apk:'/owned/assets/lazysh-0.23.0-android-foss-arm64.apk',bytes:12,certificateSha256:'c'.repeat(64),flavor:'foss',nonce,sha:'b'.repeat(40),sha256:'d'.repeat(64),tag:'v0.23.0',version:'0.23.0'};
  expect(publishedState(state,base)).toBe(true);
  for(const patch of [{flavor:'../private'},{apk:'/private/foreign.apk'},{message:'private-error'},{nonce:'x'.repeat(33)},{bytes:Infinity},{tag:'v0.24.0'},{sha:null}])expect(publishedState({...state,...patch},base)).toBe(false);
});

test('driver exception classification retains only one exact closed stage and never arbitrary error data',()=>{
  const line=(stage:string)=>`INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: Published APK UI: ${stage}`;
  for(const stage of ['ARGUMENTS','DEVICE_ADMISSION','LAUNCH','LAUNCH_WINDOW','WORKSPACE','WORKSPACE_READINESS','WORKSPACE_ADD_HOST','DRAWER','ADD_HOST','NAME','HOSTNAME','USERNAME','KEYBOARD','SCROLL_OWNER','FORM_SCROLL','SAVE_HOST','SAVED_HOST','EDIT_HOST','READBACK','COMPLETE'])expect(publishedDriverStage(line(stage))).toBe(stage);
  expect(publishedDriverStage(line('WORKSPACE')+'\n'+line('WORKSPACE'))).toBe('WORKSPACE');
  for(const value of ['',line('PRIVATE_SECRET'),line('NAME')+' private-path',line('NAME')+'\n'+line('LAUNCH'),'private-error',line('NAME')+'\0','x'.repeat(65537)])expect(publishedDriverStage(value)).toBe('unavailable');
});
test('parent UI phase and closed driver stage survive independently without raw failure output',()=>fixture(async asset=>{
  const f=fake(args=>args.includes('instrument')?'INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: Published APK UI: HOSTNAME\nINSTRUMENTATION_STATUS_CODE: -2\nprivate-output':undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.receipt).toMatchObject({failureStage:'create',driverStage:'HOSTNAME',driverObservation:{state:'unavailable'},cleanup:'passed'});
  expect(result.passed).toBe(false);expect(JSON.stringify(result)).not.toContain('private-output');
}));
test.each(['LAUNCH_WINDOW','SCROLL_OWNER','FORM_SCROLL'])('failed %s admission never grants create, retry, relaunch or reinstall success',stage=>fixture(async asset=>{
  const f=fake(args=>args.includes('instrument')?`INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: Published APK UI: ${stage}\nINSTRUMENTATION_STATUS_CODE: -2\nprivate-node-or-package`:undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.passed).toBe(false);expect(result.receipt).toMatchObject({failureStage:'create',driverStage:stage,created:false,relaunched:false,reinstalled:false,preserved:false,cleanup:'passed'});
  expect(f.calls.filter(args=>args.includes('instrument'))).toHaveLength(1);
  expect(f.calls.some(args=>args.includes('-r')&&args.includes('install'))).toBe(false);
  expect(f.calls.slice(-2).map(args=>args.at(-1))).toEqual(['app.lazysh.acceptance','app.lazysh.client']);
  expect(JSON.stringify(result)).not.toContain('private-node-or-package');
}));

const noReadiness={outcome:'unavailable',elapsedMs:null,polls:0,overflow:false,lastAdd:'unavailable',lastOpen:'unavailable'};
const noSave={operation:'unavailable',raw:'unavailable',visible:'unavailable'};
const observedInput={inputOperation:'LOOKUP',inputField:'NAME',readbackMatched:null,foreground:'target',screenOn:true,keyguardLocked:false,editableCount:3,editableOverflow:false,hintShapes:['name-label-placeholder','hostname-placeholder','username-label'],addHostMatches:'zero',openHostsMatches:'one',webView:true,readiness:noReadiness,save:noSave};
const observationLine=(value:unknown)=>`INSTRUMENTATION_STATUS: lazyshPublishedObservation=${JSON.stringify(value)}`;
test('driver operation observation projects exact closed fields and explicit unavailable samples',()=>{
  expect(publishedDriverObservation(observationLine(observedInput))).toEqual({state:'available',...observedInput});
  const actualGuest={...observedInput,editableCount:4,hintShapes:['name-label','hostname-label','empty','username-label']};
  expect(publishedDriverObservation(observationLine(actualGuest))).toEqual({state:'available',...actualGuest});
  expect(publishedDriverObservation(observationLine({...observedInput,inputOperation:'READBACK',readbackMatched:false}))).toMatchObject({state:'available',inputOperation:'READBACK',readbackMatched:false});
  expect(publishedDriverObservation(observationLine({...observedInput,editableCount:null,editableOverflow:null,hintShapes:[]}))).toMatchObject({state:'available',editableCount:null});
  expect(publishedDriverObservation(observationLine({...observedInput,editableCount:8,editableOverflow:true,hintShapes:Array(8).fill('other')}))).toMatchObject({state:'available',editableOverflow:true});
});
test('workspace observations distinguish absent, unique and ambiguous exact captions without retaining AX data',()=>{
  for(const count of ['zero','one','multiple','unavailable']){
    const sample={...observedInput,inputOperation:'NONE',inputField:'NONE',addHostMatches:count,openHostsMatches:count,webView:null};
    expect(publishedDriverObservation(observationLine(sample))).toEqual({state:'available',...sample});
  }
  for(const patch of [{addHostMatches:null},{openHostsMatches:2},{webView:{}},{caption:'private-accessibility-label'}]){
    expect(publishedDriverObservation(observationLine({...observedInput,...patch}))).toEqual({state:'unavailable'});
  }
});
test('readiness trace distinguishes original return, exception and unentered wait with bounded short-circuit samples',()=>{
  const ready={outcome:'true',elapsedMs:37,polls:1,overflow:false,lastAdd:'one',lastOpen:'unavailable'};
  const falseWait={...ready,outcome:'false',elapsedMs:5100,polls:51,lastAdd:'zero',lastOpen:'zero'};
  for(const readiness of [noReadiness,ready,falseWait,{...ready,outcome:'exception',lastAdd:'zero'},
    {...ready,outcome:'exception',polls:0,lastAdd:'unavailable'},
    {...falseWait,elapsedMs:60000,polls:64,overflow:true}]){
    expect(publishedDriverObservation(observationLine({...observedInput,readiness}))).toMatchObject({state:'available',readiness});
  }
});
test('readiness projection rejects unbounded, inconsistent, missing and private trace data wholesale',()=>{
  const readiness={outcome:'false',elapsedMs:5001,polls:50,overflow:false,lastAdd:'zero',lastOpen:'zero'};
  for(const patch of [{outcome:'private-exception'},{elapsedMs:-1},{elapsedMs:60001},{elapsedMs:1.5},{elapsedMs:null},
    {polls:-1},{polls:65},{polls:0},{polls:1.5},{overflow:true},{overflow:'private'},
    {lastAdd:'private-caption'},{lastAdd:'one'},{lastAdd:'unavailable'},{lastOpen:'private-caption'},{message:'private-error'}]){
    const result=publishedDriverObservation(observationLine({...observedInput,readiness:{...readiness,...patch}}));
    expect(result).toEqual({state:'unavailable'});expect(JSON.stringify(result)).not.toContain('private');
  }
  for(const value of [null,[],{},'private-trace',{...noReadiness,elapsedMs:0},{...noReadiness,polls:1}])
    expect(publishedDriverObservation(observationLine({...observedInput,readiness:value}))).toEqual({state:'unavailable'});
  const {readiness:missing,...legacy}=observedInput;
  expect(publishedDriverObservation(observationLine(legacy))).toEqual({state:'unavailable'});
});
test('save trace distinguishes unavailable, absent, ambiguous, clipped and click-stage original matches',()=>{
  for(const save of [noSave,{operation:'lookup',raw:'unavailable',visible:'unavailable'},
    {operation:'lookup',raw:'zero',visible:'zero'},{operation:'lookup',raw:'multiple',visible:'multiple'},
    {operation:'lookup',raw:'one',visible:'zero'},{operation:'lookup',raw:'one',visible:'unavailable'},
    {operation:'click',raw:'one',visible:'one'},{operation:'complete',raw:'multiple',visible:'one'}]){
    expect(publishedDriverObservation(observationLine({...observedInput,save}))).toMatchObject({state:'available',save});
  }
  for(const save of [null,{},[],{operation:'private-action',raw:'one',visible:'one'},
    {...noSave,message:'private-error'},{...noSave,raw:'one'},
    {operation:'lookup',raw:'private-label',visible:'zero'},{operation:'lookup',raw:1,visible:'zero'},
    {operation:'lookup',raw:'unavailable',visible:'zero'},{operation:'lookup',raw:'zero',visible:'one'},
    {operation:'lookup',raw:'one',visible:'multiple'},{operation:'click',raw:'multiple',visible:'multiple'},
    {operation:'complete',raw:'one',visible:'zero'}]){
    const result=publishedDriverObservation(observationLine({...observedInput,save}));
    expect(result).toEqual({state:'unavailable'});expect(JSON.stringify(result)).not.toContain('private');
  }
  const {save:missing,...legacy}=observedInput;
  expect(publishedDriverObservation(observationLine(legacy))).toEqual({state:'unavailable'});
});
test.each(['lookup','click'])('save %s failure preserves the original stage and cleanup independently of caption diagnosis',operation=>fixture(async asset=>{
  const save={operation,raw:'one',visible:operation==='lookup'?'zero':'one'};
  const f=fake(args=>args.includes('instrument')?observationLine({...observedInput,save})+'\nINSTRUMENTATION_STATUS: stack=java.lang.AssertionError: Published APK UI: SAVE_HOST\nINSTRUMENTATION_STATUS_CODE: -2\nprivate-AX-error':undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.passed).toBe(false);expect(result.receipt).toMatchObject({failureStage:'create',driverStage:'SAVE_HOST',driverObservation:{state:'available',save},cleanup:'passed'});
  expect(JSON.stringify(result)).not.toContain('private-AX-error');
  expect(f.calls.filter(args=>args.includes('instrument'))).toHaveLength(1);
}));
test.each(['WORKSPACE_READINESS','WORKSPACE_ADD_HOST'])('workspace %s failure survives independently of failure-only sampled counts',stage=>fixture(async asset=>{
  const readiness={outcome:stage==='WORKSPACE_READINESS'?'exception':'true',elapsedMs:42,polls:1,overflow:false,lastAdd:stage==='WORKSPACE_READINESS'?'unavailable':'one',lastOpen:'unavailable'};
  const observation={...observedInput,inputOperation:'NONE',inputField:'NONE',addHostMatches:'multiple',openHostsMatches:'unavailable',webView:false,readiness};
  const f=fake(args=>args.includes('instrument')?observationLine(observation)+`\nINSTRUMENTATION_STATUS: stack=java.lang.AssertionError: Published APK UI: ${stage}\nINSTRUMENTATION_STATUS_CODE: -2`:undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.passed).toBe(false);expect(result.receipt).toMatchObject({failureStage:'create',driverStage:stage,driverObservation:{state:'available',addHostMatches:'multiple',openHostsMatches:'unavailable',webView:false,readiness},cleanup:'passed'});
  expect(f.calls.filter(args=>args.includes('instrument'))).toHaveLength(1);
}));
test('malformed readiness trace cannot replace the original readiness failure or owned cleanup',()=>fixture(async asset=>{
  const f=fake(args=>args.includes('instrument')?observationLine({...observedInput,readiness:{message:'private-query-failure'}})+'\nINSTRUMENTATION_STATUS: stack=java.lang.AssertionError: Published APK UI: WORKSPACE_READINESS\nINSTRUMENTATION_STATUS_CODE: -2':undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.passed).toBe(false);expect(result.receipt).toMatchObject({failureStage:'create',driverStage:'WORKSPACE_READINESS',driverObservation:{state:'unavailable'},cleanup:'passed'});
  expect(JSON.stringify(result)).not.toContain('private-query-failure');
}));
test('malformed, private or oversized operation data is never partially retained',()=>{
  const malformed=[{message:'private-exception'},{inputOperation:'private-command'},{inputField:'private-host'},{foreground:'private.package'},
    {screenOn:'private-value'},{readbackMatched:true},{editableCount:9},{editableCount:-1},{editableOverflow:true},
    {hintShapes:['private-hint']},{hintShapes:Array(9).fill('other')},{editableCount:null},{inputOperation:'NONE'},{path:'/private/path'},{addHostMatches:3},{openHostsMatches:'private-caption'},{webView:'private-class'}];
  for(const patch of malformed){const result=publishedDriverObservation(observationLine({...observedInput,...patch}));expect(result).toEqual({state:'unavailable'});expect(JSON.stringify(result)).not.toContain('private');}
  for(const raw of ['',observationLine(observedInput)+'\n'+observationLine(observedInput),observationLine(observedInput)+'\0','INSTRUMENTATION_STATUS: lazyshPublishedObservation={broken',observationLine({private:'x'.repeat(2049)}),'x'.repeat(65537)])expect(publishedDriverObservation(raw)).toEqual({state:'unavailable'});
});
test('original UI failure, readback observation and cleanup results remain distinct',()=>fixture(async asset=>{
  const observation={...observedInput,inputOperation:'READBACK',readbackMatched:false};
  const f=fake(args=>args.includes('instrument')?observationLine(observation)+'\nINSTRUMENTATION_STATUS: stack=java.lang.AssertionError: Published APK UI: NAME\nINSTRUMENTATION_STATUS_CODE: -2\nprivate-native-message':undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.passed).toBe(false);expect(result.receipt).toMatchObject({failureStage:'create',driverStage:'NAME',driverObservation:{state:'available',inputOperation:'READBACK',readbackMatched:false},cleanup:'passed'});
  expect(JSON.stringify(result)).not.toContain('private-native-message');
}));
test('diagnostic metadata cannot satisfy or relax the original successful UI phase protocol',()=>{
  const report=observationLine(observedInput);
  expect(publishedInstrumentation(report,'create')).toBe(false);
  expect(publishedInstrumentation(output('create')+'\n'+report,'create')).toBe(true);
  expect(publishedDriverObservation('INSTRUMENTATION_STATUS: lazyshPublishedObservation='+JSON.stringify(observedInput).slice(0,-1))).toEqual({state:'unavailable'});
});

const progressFrame=(stage='WORKSPACE_READINESS',event='entry')=>`INSTRUMENTATION_STATUS: lazyshPublishedProgress=${JSON.stringify({stage,event})}\nINSTRUMENTATION_STATUS_CODE: 0\n`;
test('progress retains only the last completely framed allowlisted wrapper boundary',()=>{
  expect(publishedDriverProgress(progressFrame())).toEqual({state:'available',stage:'WORKSPACE_READINESS',event:'entry'});
  const completed=progressFrame('WORKSPACE')+progressFrame()+progressFrame('WORKSPACE_READINESS','exit');
  expect(publishedDriverProgress(completed)).toEqual({state:'available',stage:'WORKSPACE_READINESS',event:'exit'});
  expect(publishedDriverProgress(progressFrame().replaceAll('\n','\r\n'))).toMatchObject({state:'available'});
  for(let end=0;end<progressFrame().length;end++)expect(publishedDriverProgress(progressFrame().slice(0,end))).toEqual({state:'unavailable'});
  // A later unfinished frame cannot replace an earlier complete observation.
  expect(publishedDriverProgress(completed+progressFrame('SAVE_HOST').slice(0,-2))).toEqual({state:'available',stage:'WORKSPACE_READINESS',event:'exit'});
  expect(publishedDriverProgress(progressFrame().repeat(256))).toMatchObject({state:'available'});
  expect(publishedDriverProgress(progressFrame().repeat(257))).toEqual({state:'unavailable'});
});
test('malformed, private, oversized and NUL progress fails closed rather than projecting partial fields',()=>{
  const prefix='INSTRUMENTATION_STATUS: lazyshPublishedProgress=';
  const malformed=[progressFrame('PRIVATE_CLASS'),progressFrame('NAME','private-event'),
    `${prefix}{"stage":"NAME","event":"entry","message":"private-value"}\nINSTRUMENTATION_STATUS_CODE: 0\n`,
    ...['null','[]','{}','{"stage":"NAME"}','{"event":"entry"}','{"stage":"NAME","event":"entry","stage":"SAVE_HOST"}','private-value'].map(value=>`${prefix}${value}\nINSTRUMENTATION_STATUS_CODE: 0\n`),
    progressFrame().replace('STATUS_CODE: 0','STATUS_CODE: 1'),
    progressFrame().replace('INSTRUMENTATION_STATUS_CODE: 0','INSTRUMENTATION_STATUS: private=private-value\nINSTRUMENTATION_STATUS_CODE: 0'),
    progressFrame()+'\0',progressFrame()+'x'.repeat(65536),progressFrame()+'é'.repeat(32768),
    `${prefix}${'x'.repeat(257)}\nINSTRUMENTATION_STATUS_CODE: 0\n`];
  for(const sample of malformed){
    const result=publishedDriverProgress(sample);expect(result).toEqual({state:'unavailable'});
    expect(JSON.stringify(result)).not.toContain('private');
  }
  expect(publishedCommandProgress(new Error('private-value'))).toEqual({state:'unavailable'});
});
test.skipIf(process.platform!=='linux')('actual fragmented output preserves complete progress on nonzero exit without retaining private bytes',async()=>{
  const marker=progressFrame('SAVE_HOST','exit');
  const script=`const marker=${JSON.stringify(marker)};process.stdout.write(marker.slice(0,31));setTimeout(()=>{process.stdout.write(marker.slice(31));process.stdout.write('private-stdout');process.stderr.write('private-stderr');process.exitCode=9;},10);`;
  const error=await publishedOutput(process.execPath,['-e',script],1000).catch(error=>error);
  expect(publishedCommandFailure(error)).toBe('nonzero');
  expect(publishedCommandProgress(error)).toEqual({state:'available',stage:'SAVE_HOST',event:'exit'});
  expect(JSON.stringify(error)+String(error)).not.toContain('private');
  expect(publishedCommandProgress(Object.create(Object.getPrototypeOf(error)))).toEqual({state:'unavailable'});
});
test.skipIf(process.platform!=='linux').each([false,true])('actual marker-then-hang keeps deadline and owned cleanup failure=%s',cleanupFails=>fixture(async asset=>{
  const pidFile=join(dirname(asset.apk),'child.pid'),marker=progressFrame();
  const script=`require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.stdout.write(${JSON.stringify(marker)});process.stdout.write('private-stdout');process.stderr.write('private-stderr');setInterval(()=>{},1000);`;
  const f=fake();let calls=0;
  const run:PublishedCommand=async(program,args,milliseconds)=>{
    if(args.includes('instrument')){
      calls++;expect(milliseconds).toBe(45000);
      return publishedOutput(process.execPath,['-e',script,pidFile],300);
    }
    const value=await f.run(program,args,milliseconds);
    if(cleanupFails&&args.includes('uninstall')&&args.at(-1)==='app.lazysh.acceptance')throw new Error('private-cleanup');
    return value;
  };
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,run,admitted);
  expect(result.passed).toBe(false);expect(calls).toBe(1);
  expect(result.receipt).toMatchObject({failureStage:'create',created:false,relaunched:false,reinstalled:false,preserved:false,
    driverCommand:{outcome:'deadline'},driverStage:'unavailable',driverObservation:{state:'unavailable'},
    driverProgress:{state:'available',stage:'WORKSPACE_READINESS',event:'entry'},cleanup:cleanupFails?'failed':'passed'});
  expect(f.calls.slice(-2).map(args=>args.at(-1))).toEqual(['app.lazysh.acceptance','app.lazysh.client']);
  const pid=Number(await readFile(pidFile,'utf8'));expect(Number.isInteger(pid)&&pid>0).toBe(true);
  expect(await identity(pid)).toBeUndefined();expect(JSON.stringify(result)).not.toContain('private');
}));
test.each(['entry','exit'])('COMPLETE %s progress alone cannot grant success or skip owned cleanup',event=>fixture(async asset=>{
  const f=fake(args=>args.includes('instrument')?progressFrame('COMPLETE',event):undefined);
  const result=await publishedAcceptance(asset,'/owned/driver.apk',nonce,env,f.run,admitted);
  expect(result.passed).toBe(false);expect(result.receipt).toMatchObject({failureStage:'create',created:false,relaunched:false,reinstalled:false,preserved:false,
    driverCommand:{outcome:'completed'},driverStage:'unavailable',driverObservation:{state:'unavailable'},
    driverProgress:{state:'available',stage:'COMPLETE',event},cleanup:'passed'});
  expect(f.calls.filter(args=>args.includes('instrument'))).toHaveLength(1);
}));
