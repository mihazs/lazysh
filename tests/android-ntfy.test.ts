import {expect,test,spyOn} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm,stat,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {OwnedNtfyPackages,ntfyToolFailure,ntfyEnvironment,distributorHasGooglePush,inspectAcceptanceTrust,realNtfyChallenge,realNtfyStartup,relayInput,ntfyHealth,privateInputCommand,writePrivateInput,firstLaunchObservation,permissionActionObservation,validateNtfyReport,nativeFailureStage,settingsObservation,returnStateObservation,eventObservation,ntfyClockComparison,observeNtfyClock,OwnedNtfyClock,controlledNtfyClockReadback,sameNtfyClockOwner,absentNtfyPackages} from './support/androidNtfy';
import {OwnedProcess} from './support/androidSsh';

const clockPoint=(wall:number,nanos=0n)=>({wall,before:nanos,after:nanos});
test('controlled clock admits only an entire positive interval within the declared bound',()=>{
  const before=clockPoint(100000),after=clockPoint(100010,10000000n);
  for(const [raw,result]of [['100010','outsideDeclaredOffset'],['100011','outsideDeclaredOffset'],['100012','verified'],
    ['101999','verified'],['102000','outsideDeclaredOffset'],['100005','outsideDeclaredOffset'],['%s%3N','malformed'],
    ['101000\r\n','malformed'],['101000\n\n','malformed'],['NaN','malformed'],['8640000000000000','malformed']]as const)
    expect(controlledNtfyClockReadback(raw,before,after)).toBe(result);
  expect(controlledNtfyClockReadback('101000',before,clockPoint(100251,251000000n))).toBe('wideBracket');
  expect(controlledNtfyClockReadback('101000',before,clockPoint(100248,248000000n))).toBe('verified');
  expect(controlledNtfyClockReadback('101000',before,clockPoint(100249,249000000n))).toBe('wideBracket');
  expect(controlledNtfyClockReadback('101000',before,clockPoint(100100,1000000n))).toBe('hostDiscontinuity');
  expect(controlledNtfyClockReadback('101000',before,after,clockPoint(99000))).toBe('hostDiscontinuity');
  expect(controlledNtfyClockReadback('101000',clockPoint(NaN),after)).toBe('hostDiscontinuity');
});

function controlledClockFixture(options:{auto?:boolean;autoReply?:string;readback?:string;unchanged?:boolean;occupied?:boolean;unsupported?:boolean;restoreFails?:boolean;ignoreRestore?:boolean;identityLostAfterSet?:boolean}={}) {
  const commands:string[][]=[],events:string[]=[];let auto=options.auto??true,set:number|undefined,index=0;
  const points=[clockPoint(100000),clockPoint(100010,10000000n),clockPoint(100020,20000000n)].map(point=>({...point,after:point.after+100n}));
  const clock=new OwnedNtfyClock(async args=>{
    commands.push(args);events.push(args.join(' '));
    if(args[1]==='pm')return options.occupied?'package:app.lazysh.client\n':'';
    if(args[1]==='date')return options.readback??String(options.unchanged?100015:set!+15)+'\n';
    if(args[2]==='alarm'){if(options.unsupported)throw new Error('private unsupported token');set=Number(args[4]);return '';}
    if(args[3]==='is_auto_detection_enabled')return options.autoReply??String(auto)+'\n';
    if(args[3]==='set_auto_detection_enabled'){
      if(options.restoreFails&&set!==undefined)throw new Error('private restoration token');
      if(!options.ignoreRestore||set===undefined)auto=args[4]==='true';return '';
    }
    throw new Error('Unexpected command');
  },async()=>{events.push('identity');if(options.identityLostAfterSet&&set!==undefined)throw new Error('Owned identity changed');},()=>{
    events.push('sample');return points[index++];
  });
  return {clock,commands,events,get auto(){return auto;}};
}

test('one fixed clock setup restores the exact original boolean only after absent-state teardown',async()=>{
  for(const auto of [true,false]) {
    const f=controlledClockFixture({auto});await f.clock.prepare();
    expect(f.clock.observation()).toMatchObject({state:'verified',readback:'verified',restoration:'pending'});
    expect(f.commands.filter(a=>a[2]==='alarm')).toEqual([['shell','cmd','alarm','set-time','101000']]);
    await expect(f.clock.prepare()).rejects.toThrow('cannot be repeated');
    await f.clock.restore(async()=>{f.events.push('teardown');});
    expect(f.auto).toBe(auto);expect(f.clock.observation().restoration).toBe('restored');
    const teardown=f.events.indexOf('teardown');
    expect(f.events.slice(teardown+1)).toContain(`shell cmd time_detector set_auto_detection_enabled ${auto}`);
    expect(f.commands.filter(a=>a[2]==='alarm')).toHaveLength(1);
    expect(JSON.stringify(f.clock.observation())).not.toMatch(/101000|private|token|epoch|boot|hash/);
    await expect(f.clock.restore(async()=>{})).rejects.toThrow('cannot be repeated');
  }
});

test('unsupported or unchanged clock never passes on set-time success and never retries',async()=>{
  for(const options of [{unsupported:true},{unchanged:true},{readback:'%s%3N\n'}]) {
    const f=controlledClockFixture(options);await expect(f.clock.prepare()).rejects.toThrow();
    expect(f.clock.observation().state).toBe('preparing');
    expect(f.commands.filter(a=>a[2]==='alarm')).toHaveLength(1);
    await f.clock.restore(async()=>{});expect(f.auto).toBe(true);
    expect(f.clock.observation().restoration).toBe('restored');
  }
});

test('malformed automatic-time state cannot be guessed or mutated',async()=>{
  for(const autoReply of ['','True','true\n\n','false\r\n','private']) {
    const f=controlledClockFixture({autoReply});await expect(f.clock.prepare()).rejects.toThrow('automatic time response invalid');
    expect(f.commands.some(a=>a[3]==='set_auto_detection_enabled'||a[2]==='alarm')).toBe(false);
    await f.clock.restore(async()=>{throw new Error('No restoration should be needed');});
  }
});

test('package or identity failure admits no mutation and cannot restore beneath retained state',async()=>{
  const occupied=controlledClockFixture({occupied:true});await expect(occupied.clock.prepare()).rejects.toThrow('packages/state must be absent');
  expect(occupied.commands.every(a=>a[1]==='pm')).toBe(true);
  let commands=0;const original=new Error('Owned identity failed');
  const denied=new OwnedNtfyClock(async()=>{commands++;return '';},async()=>{throw original;});
  await expect(denied.prepare()).rejects.toBe(original);expect(commands).toBe(0);
  const blocked=controlledClockFixture();await blocked.clock.prepare();const count=blocked.commands.length;
  await expect(blocked.clock.restore(async()=>{throw original;})).rejects.toBe(original);
  expect(blocked.commands).toHaveLength(count);expect(blocked.clock.observation().restoration).toBe('blocked');
  const lost=controlledClockFixture({identityLostAfterSet:true});await expect(lost.clock.prepare()).rejects.toThrow('identity changed');
  await expect(lost.clock.restore(async()=>{})).rejects.toThrow('identity changed');
  expect(lost.commands.filter(a=>a[3]==='set_auto_detection_enabled')).toHaveLength(1);
});

test('restoration failure is closed, recorded and cannot be retried',async()=>{
  for(const options of [{restoreFails:true},{ignoreRestore:true}]) {
    const f=controlledClockFixture(options);await f.clock.prepare();let cleanup:unknown;
    try{await f.clock.restore(async()=>{});}catch(error){cleanup=error;}
    expect(cleanup).toBeInstanceOf(Error);
    expect(String(cleanup)).not.toContain('private');expect(f.clock.observation().restoration).toBe('failed');
    await expect(f.clock.restore(async()=>{})).rejects.toThrow('cannot be repeated');
  }
  const options={occupied:false},retained=controlledClockFixture(options);await retained.clock.prepare();options.occupied=true;
  await expect(retained.clock.restore(async()=>{})).rejects.toThrow('packages/state must be absent');
  expect(retained.clock.observation().restoration).toBe('blocked');
  expect(retained.commands.filter(a=>a[3]==='set_auto_detection_enabled')).toHaveLength(1);
});

test('clock ownership requires stable QEMU-admitted bridge, transport and boot observations',()=>{
  const owner={server:{state:'available' as const,hash:'server'},guest:{connection:'device',process:'unavailable',mainPids:[],reverse:'not-created',
    transport:'available',transportHash:'transport',boot:'available',bootHash:'boot',adbd:'available',adbdHash:'adbd'}};
  expect(sameNtfyClockOwner(owner,owner)).toBe(true);
  expect(sameNtfyClockOwner({...owner,guest:{...owner.guest,connection:'offline'}},owner)).toBe(false);
  expect(sameNtfyClockOwner(owner,{...owner,server:{state:'inconclusive',hash:null}})).toBe(false);
  for(const field of ['transportHash','bootHash','adbdHash','connection']as const)
    expect(sameNtfyClockOwner(owner,{...owner,guest:{...owner.guest,[field]:'changed'}})).toBe(false);
});

test('teardown absence uses strict exact package names rather than uninstall acknowledgements or prefixes',async()=>{
  const queried:string[]=[];
  await absentNtfyPackages(async args=>{queried.push(args.at(-1)!);return 'package:app.lazysh.client.unrelated\n';});
  expect(queried).toEqual(['io.heckel.ntfy','app.lazysh.client.test','app.lazysh.client']);
  for(const reply of ['package:app.lazysh.client\n','private output','\n','package:app.lazysh.client.unrelated\r\n','package:app.lazysh.client.unrelated\n'.repeat(200)])
    await expect(absentNtfyPackages(async()=>reply)).rejects.toThrow('packages/state must be absent');
  await expect(absentNtfyPackages(async()=>{throw new Error('Read unavailable');})).rejects.toThrow('Read unavailable');
});
test('host-device comparison accounts for second and millisecond quantization',()=>{
  const compare=(guest:string,start=100000,end=100010)=>ntfyClockComparison(guest,clockPoint(start),clockPoint(end,BigInt(end-start)*1000000n));
  expect(compare('100\n')).toMatchObject({status:'observed',offset:'overlapsZero',magnitude:'crossesBand',uncertainty:'atMostTwoSeconds'});
  expect(compare('99')).toMatchObject({offset:'behind',magnitude:'crossesBand'});
  expect(compare('98')).toMatchObject({offset:'behind',magnitude:'oneToFiveSeconds'});
  expect(compare('102')).toMatchObject({offset:'ahead',magnitude:'oneToFiveSeconds'});
  expect(compare('90')).toMatchObject({offset:'behind',magnitude:'fiveToThirtySeconds'});
  expect(compare('60')).toMatchObject({offset:'behind',magnitude:'atLeastThirtySeconds'});
  expect(compare('140')).toMatchObject({offset:'ahead',magnitude:'atLeastThirtySeconds'});
  expect(compare('105')).toMatchObject({magnitude:'crossesBand'});
  expect(compare('100',100000,103000)).toMatchObject({offset:'overlapsZero',uncertainty:'twoToFiveSeconds'});
  expect(compare('100',100000,106000)).toMatchObject({uncertainty:'overFiveSeconds'});
  for(const [elapsed,uncertainty]of [[999,'atMostTwoSeconds'],[1000,'twoToFiveSeconds'],[3999,'twoToFiveSeconds'],[4000,'overFiveSeconds']]as const)
    expect(compare('100',100000,100000+elapsed).uncertainty).toBe(uncertainty);
});

test('clock comparison suppresses offset claims after host discontinuity and malformed observations',()=>{
  const start=clockPoint(100000);
  for(const [end,progress]of [[clockPoint(103000,1000000n),'wallAhead'],[clockPoint(99000,1000000n),'wallBehind']]as const)
    expect(ntfyClockComparison('98',start,end)).toMatchObject({status:'hostDiscontinuity',offset:'unavailable',magnitude:'unavailable',hostProgress:progress});
  expect(ntfyClockComparison('100',start,clockPoint(100000,1000000n))).toMatchObject({status:'observed'});
  expect(ntfyClockComparison('100',start,clockPoint(100001))).toMatchObject({status:'observed'});
  expect(ntfyClockComparison('100',start,clockPoint(99999))).toMatchObject({status:'hostDiscontinuity',hostProgress:'wallBehind'});
  for(const text of ['','private-key','100\nprivate','100\n\n','100\r\n',' 100','0100','-1','NaN','Infinity','100.5','9'.repeat(200)])
    expect(ntfyClockComparison(text,start,start)).toMatchObject({status:'malformed',offset:'unavailable'});
  for(const point of [clockPoint(NaN),clockPoint(Infinity),clockPoint(-1),clockPoint(1.5),clockPoint(Number.MAX_SAFE_INTEGER),clockPoint(100000,-1n),{wall:100000,before:1n,after:0n}])
    expect(ntfyClockComparison('100',point,start)).toMatchObject({status:'outOfBounds',offset:'unavailable'});
  expect(ntfyClockComparison('8640000000000',start,start)).toMatchObject({status:'outOfBounds'});
  expect(ntfyClockComparison('100',clockPoint(100000,2n),clockPoint(100000,1n))).toMatchObject({status:'outOfBounds'});
  expect(ntfyClockComparison('100',start,clockPoint(100000,9_223_372_036_854_775_808n))).toMatchObject({status:'outOfBounds'});
  expect(JSON.stringify(ntfyClockComparison('98',start,clockPoint(100001,1000000n)))).not.toMatch(/[0-9]|private|epoch|wallTime|nanos/);
});

test('one diagnostic read preserves owned identity checks and redacts command failures',async()=>{
  const calls:string[]=[];let sample=0;
  const observed=await observeNtfyClock(async()=>{calls.push('read');return '98\n';},async()=>{calls.push('check');},()=>clockPoint(100000,sample++===0?0n:1000000n));
  expect(calls).toEqual(['check','read','check']);expect(observed.offset).toBe('behind');
  const failed=await observeNtfyClock(async()=>{throw new Error('private-token /private/path 123');},async()=>{},()=>clockPoint(100000));
  expect(failed).toMatchObject({status:'commandFailed',offset:'unavailable'});
  expect(JSON.stringify(failed)).not.toMatch(/private|token|path|123/);
  let reads=0,checks=0;
  const original=new Error('Owned identity changed');
  await expect(observeNtfyClock(async()=>{reads++;return '100';},async()=>{throw original;})).rejects.toBe(original);expect(reads).toBe(0);
  await expect(observeNtfyClock(async()=>{throw new Error('private command');},async()=>{if(++checks===2)throw original;},()=>clockPoint(100000))).rejects.toBe(original);
  expect(checks).toBe(2);
  checks=0;
  await expect(observeNtfyClock(async()=> '100',async()=>{if(++checks===2)throw original;},()=>clockPoint(100000))).rejects.toBe(original);
});

test('diagnostic command teardown settles before the final identity check',async()=>{
  const child=new OwnedProcess(process.execPath,['-e','process.stdout.write("private");process.exit(7)']);
  const result=await observeNtfyClock(()=>child.finish('owned clock unit fixture',2000),async()=>{
    if(child.child.exitCode!==null)expect(await child.liveIdentity()).toBeUndefined();
  },()=>clockPoint(100000));
  expect(result.status).toBe('commandFailed');expect(child.child.exitCode).toBe(7);
  expect(await child.liveIdentity()).toBeUndefined();expect(child.child.stdout!.destroyed).toBe(true);
});

test('successful and timed-out diagnostic children release owned handles without changing the caller budget',async()=>{
  for(const timeout of [false,true]) {
    const child=new OwnedProcess(process.execPath,['-e',timeout?'setInterval(()=>{},1000)':'process.stdout.write("100\\n")']);
    let checks=0;
    const result=await observeNtfyClock(()=>child.finish('owned clock cleanup fixture',timeout?25:2000),async()=>{checks++;},()=>clockPoint(100000));
    expect(result.status).toBe(timeout?'commandFailed':'observed');expect(checks).toBe(2);
    expect(await child.liveIdentity()).toBeUndefined();expect(child.child.stdout!.destroyed).toBe(true);
    expect(child.child.stdin!.destroyed).toBe(true);expect(child.child.stderr!.destroyed).toBe(true);
  }
});

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

test('first-launch failures retain only enumerated package state and finite flags',()=>{
  const diagnostic='Distributor menu; foreground=permission allow=true deny=true toolbar=false ownedPrompt=true attempted=false';
  expect(firstLaunchObservation('private-prefix '+diagnostic+' private-suffix')).toEqual({foreground:'permission',allow:true,deny:true,toolbar:false,ownedPrompt:true,attempted:false});
  expect(firstLaunchObservation(diagnostic.replace('foreground=permission','foreground=private.application'))).toBeUndefined();
  expect(firstLaunchObservation(diagnostic.replace('allow=true','allow=private-data'))).toBeUndefined();
});

test('one permission action retains closed stage budgets without changing legacy observations',()=>{
  const legacy='Distributor menu; foreground=permission allow=true deny=true toolbar=false ownedPrompt=true attempted=true';
  const trace='Ntfy first-launch action[stage=click before=positive after=expired action=returned snapshot=beforeAction permission=granted]';
  expect(permissionActionObservation(legacy)).toBeUndefined();
  expect(firstLaunchObservation(legacy+' '+trace)).toEqual(firstLaunchObservation(legacy));
  expect(permissionActionObservation('private-prefix '+trace+' private-suffix')).toEqual({stage:'click',before:'positive',after:'expired',action:'returned',snapshot:'beforeAction',permission:'granted'});
  for(const permission of ['granted','denied','unavailable'])expect(permissionActionObservation(trace.replace('permission=granted',`permission=${permission}`))?.permission).toBe(permission);
  for(const [stage,before,after,action,snapshot] of [
    ['none','unavailable','unavailable','none','unavailable'],
    ['menu','expired','expired','none','beforeAction'],
    ['prompt','positive','expired','returned','afterAction'],
    ['click','positive','unavailable','calling','beforeAction'],
    ['click','positive','unavailable','threw','beforeAction'],
  ])expect(permissionActionObservation(`Ntfy first-launch action[stage=${stage} before=${before} after=${after} action=${action} snapshot=${snapshot} permission=unavailable]`)).toEqual({stage,before,after,action,snapshot,permission:'unavailable'});
  for(const bad of [trace+trace,trace.replace('stage=click','stage=private'),trace.replace('before=positive','before=1000'),
    trace.replace('permission=granted','permission=unknown'),trace.replace('action=returned','action=threw'),
    trace.replace('action=returned','action=none'),trace.replace('after=expired','after=unavailable'),
    trace.replace('before=positive','before=unavailable'),
    trace.replace('after=expired','after=unavailable').replace('action=returned','action=calling').replace('snapshot=beforeAction','snapshot=afterAction'),
    trace.replace('snapshot=beforeAction','snapshot=private'),trace.replace('permission=granted]','permission=granted elapsed=1000]'),
    trace.replace('stage=click','stage=none'),trace.replace(' before=positive',''),trace.repeat(2048),' '.repeat(256*1024)+trace])expect(permissionActionObservation(bad)).toBeUndefined();
  expect(JSON.stringify(permissionActionObservation(trace))).not.toMatch(/private|elapsed|[0-9]/);
});

test('post-click menu samples preserve the actual click budgets and first measured expiry',()=>{
  const legacy='Ntfy first-launch action[stage=menu before=expired after=expired action=returned snapshot=afterAction permission=denied]';
  const trace=legacy.replace('permission=denied]','permission=denied clickBefore=positive clickAfter=positive firstExpiry=prompt]');
  expect(permissionActionObservation(trace)).toEqual({...permissionActionObservation(legacy),clickBefore:'positive',clickAfter:'positive',firstExpiry:'prompt'});
  for(const firstExpiry of ['none','between','foreground','allow','deny','toolbar','prompt','menu','click'])
    expect(permissionActionObservation(trace.replace('firstExpiry=prompt',`firstExpiry=${firstExpiry}`))?.firstExpiry).toBe(firstExpiry);
  for(const bad of [trace.replace('clickBefore=positive','clickBefore=private'),trace.replace('clickAfter=positive','clickAfter=1000'),
    trace.replace('firstExpiry=prompt','firstExpiry=private-operation'),trace.replace(' clickAfter=positive',''),
    trace.replace(' clickBefore=positive',''),trace.replace(' firstExpiry=prompt',''),trace.replace('clickBefore=positive','clickBefore=unavailable'),
    trace.replace('action=returned','action=none'),trace.replace('clickAfter=positive','clickAfter=unavailable')])
    expect(permissionActionObservation(bad)).toBeUndefined();
  expect(JSON.stringify(permissionActionObservation(trace))).not.toMatch(/private|elapsed|[0-9]/);
});

test('settings observation admits only finite flags and the two-scroll limit',()=>{
  const diagnostic='Owned default server; settingsForeground=true settingsToolbar=true preferenceList=true preferenceTarget=false scrollAttempts=2';
  expect(settingsObservation('private-prefix '+diagnostic+' private-suffix')).toEqual({foreground:true,toolbar:true,list:true,target:false,scrollAttempts:2});
  expect(settingsObservation(diagnostic.replace('scrollAttempts=2','scrollAttempts=3'))).toBeUndefined();
  expect(settingsObservation(diagnostic.replace('settingsToolbar=true','settingsToolbar=private-data'))).toBeUndefined();
});

test('return failure retains one closed snapshot and discards private failure context',()=>{
  const state='foreground=ntfy settings=true defaultDialog=unavailable add=false certificate=false allow=false deny=unavailable ime=true';
  const trace=`Ntfy return state[${state}]`;
  expect(returnStateObservation(`private-prefix\n${trace}\nprivate-suffix`)).toEqual({
    foreground:'ntfy',settings:true,defaultDialog:null,add:false,certificate:false,allow:false,deny:null,ime:true});
  expect(JSON.stringify(returnStateObservation(trace))).not.toMatch(/private|origin|fingerprint|package|timestamp/);
  for(const foreground of ['ntfy','permission','lazysh','aospIme','other','unavailable'])
    expect(returnStateObservation(trace.replace('foreground=ntfy',`foreground=${foreground}`))?.foreground).toBe(foreground);
  for(const bad of [trace+trace,trace.replace('settings=true','settings=private'),trace.replace('foreground=ntfy','foreground=io.heckel.ntfy'),
    trace.replace('ime=true','ime=1'),trace.replace('state[','state[private='),trace.replace('ime=true]','ime=true private]'),
    trace.replace('settings=true','settings=true\u0000'),trace.replace('settings=true','settings=true\n'),
    trace.replace('certificate=false','certificate=false origin=secret'),trace.replace(' defaultDialog=unavailable',''),
    trace.replace('foreground=ntfy','first{foreground=ntfy'),trace+'x'.repeat(256*1024)])
    expect(returnStateObservation(bad)).toBeUndefined();
});

const eventDiagnostic='Actual bound-event notification required; eventObservation[entered=true readReturned=false initialReceipts=zero finalReceipts=one appNotifications=true postPermission=false channelEnabled=unavailable ownedNotification=false]';
test('missing event retains only closed admission, receipt and OS observations',()=>{
  const parsed=eventObservation('<failure>private-key /private/path '+eventDiagnostic+'\nat NativeWorkspaceTest.kt:1740</failure>');
  expect(parsed).toEqual({entered:true,readReturned:false,initialReceipts:'zero',finalReceipts:'one',
    appNotifications:true,postPermission:false,channelEnabled:null,ownedNotification:false});
  expect(nativeFailureStage(eventDiagnostic)).toBe('event_notification');
  expect(JSON.stringify(parsed)).not.toMatch(/private|1740|NativeWorkspaceTest|eventObservation/);
  expect(eventObservation(eventDiagnostic.replace('finalReceipts=one','finalReceipts=unavailable'))?.finalReceipts).toBe('unavailable');
  expect(eventObservation(eventDiagnostic.replace('initialReceipts=zero','initialReceipts=many'))?.initialReceipts).toBe('many');
  expect(eventObservation(eventDiagnostic.replace('readReturned=false','readReturned=true'))?.readReturned).toBe(true);
  expect(eventObservation(eventDiagnostic.replace('entered=true','entered=false'))?.entered).toBe(false);
  for(const key of ['appNotifications','postPermission','channelEnabled','ownedNotification']) {
    for(const value of ['true','false','unavailable']) {
      const text=eventDiagnostic.replace(new RegExp(key+'=(true|false|unavailable)'),key+'='+value);
      expect(eventObservation(text)?.[key as keyof NonNullable<ReturnType<typeof eventObservation>>]).toBe(value==='unavailable'?null:value==='true');
    }
  }
});

const clockDiagnostic=eventDiagnostic.replace('readReturned=false','readReturned=true').replace('ownedNotification=false]',
  'ownedNotification=false reads=one returnedReads=one writes=zero returnedWrites=zero storedEnabled=true clock=beforeIssued]');
test('event diagnosis retains bounded operation counts and closed clock categories, never raw values',()=>{
  const observed=eventObservation('private-prefix '+clockDiagnostic+' private-suffix');
  expect(observed).toMatchObject({reads:'one',returnedReads:'one',writes:'zero',returnedWrites:'zero',storedEnabled:true,clock:'beforeIssued'});
  expect(JSON.stringify(observed)).not.toMatch(/private|issuedAt|expiresAt|highWater|[0-9]/);
  for(const clock of ['unavailable','negative','rollback','beforeIssued','expired','withinWindow']) {
    expect(eventObservation(clockDiagnostic.replace('clock=beforeIssued','clock='+clock))?.clock).toBe(clock);
  }
  for(const name of ['reads','returnedReads','writes','returnedWrites']) for(const value of ['zero','one','many']) {
    const text=clockDiagnostic.replace(new RegExp(name+'=(zero|one|many)'),name+'='+value);
    expect(eventObservation(text)?.[name as keyof NonNullable<ReturnType<typeof eventObservation>>]).toBe(value);
  }
  for(const flag of ['true','false','unavailable']) {
    expect(eventObservation(clockDiagnostic.replace('storedEnabled=true','storedEnabled='+flag))?.storedEnabled).toBe(flag==='unavailable'?null:flag==='true');
  }
  for(const text of [clockDiagnostic.replace('reads=one','reads=3'),clockDiagnostic.replace('returnedWrites=zero','returnedWrites=-1'),
    clockDiagnostic.replace('storedEnabled=true','storedEnabled=private'),clockDiagnostic.replace('clock=beforeIssued','clock=1000'),
    clockDiagnostic.replace('clock=beforeIssued','clock=beforeIssued clock=expired'),clockDiagnostic.replace(' reads=one',''),
    clockDiagnostic.replace('clock=beforeIssued','clock=beforeIssued issuedAt=1000'),clockDiagnostic+clockDiagnostic]) {
    expect(eventObservation(text)).toBeUndefined();
  }
});

test.each([
  eventDiagnostic.replace('entered=true','entered=private'),
  eventDiagnostic.replace('entered=true','entered=false').replace('readReturned=false','readReturned=true'),
  eventDiagnostic.replace('initialReceipts=zero','initialReceipts=-1'),
  eventDiagnostic.replace('finalReceipts=one','finalReceipts=129'),
  eventDiagnostic.replace('appNotifications=true','appNotifications=1'),
  eventDiagnostic.replace('postPermission=false','postPermission=private-key'),
  eventDiagnostic.replace(' channelEnabled=unavailable',''),
  eventDiagnostic.replace(' ownedNotification=false',' ownedNotification=false unknown=private-path'),
  eventDiagnostic.replace('readReturned=false','readReturned=false readReturned=true'),
  eventDiagnostic.replace('required; eventObservation','required eventObservation'),
  eventDiagnostic.replace('ownedNotification=false]','ownedNotification=false-private]'),
  eventDiagnostic+eventDiagnostic,
  'eventObservation[private-data]'+eventDiagnostic,
  eventDiagnostic+'x'.repeat(256*1024),
])('malformed or ambiguous event observations retain no private text: %#',text=>{
  expect(eventObservation(text)).toBeUndefined();
});

test('every fixed native selector label retains a finite failure stage without private text',async()=>{
  const source=await readFile(resolve(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=source.split('fun ownedNtfyEncryptedChallengeUsesNativeDialogAndBackgroundCallback() {')[1]?.split('\n    @Test')[0];
  expect(body).toBeTruthy();
  const labels=[...(body??'').matchAll(/\bnode\([^\r\n]*,"([^"]+)"\)/g)].map(match=>match[1]);
  expect(labels.length).toBeGreaterThan(8);
  for(const label of labels){
    const stage=nativeFailureStage(label+' private-selector-data');
    expect(stage).not.toBe('other_native_failure');expect(stage).toMatch(/^[a-z_]+$/);
  }
  expect(nativeFailureStage('unrecognized-private-data')).toBe('other_native_failure');
  expect(nativeFailureStage('Owned default server')).toBe('default_server_preference');
  expect(nativeFailureStage('Save owned default server')).toBe('default_server_save');
});

test('native receipt requires every exact owned case without substitution or skips',()=>{
  const cases=['ownedNtfyEncryptedChallengeUsesNativeDialogAndBackgroundCallback','ownedNtfyFirstLaunchBudgetAndOneTimePermissionPolicy',
    'ownedUnifiedPushEventParserAndKeystoreReplayStateFailClosed'];
  const rows=cases.map(name=>`<testcase name="${name}" classname="app.lazysh.client.NativeWorkspaceTest" />`);
  const report=`<testsuite>${rows.join('')}</testsuite>`;
  expect(validateNtfyReport(report).passed).toBe(3);
  for(const invalid of [rows[0],rows[0]+rows[0],rows[0]+rows[0]+`<system-out>name="${cases[1]}"</system-out>`,
    rows[0]+`<system-out><![CDATA[${rows[1]}]]></system-out>`,rows[0]+`<!--${rows[1]}-->`,
    report.replace('classname="app.lazysh.client.NativeWorkspaceTest"','classname="foreign.Case"'),
    report.replace('</testsuite>','<skipped /></testsuite>'),report+rows[0]]){
    expect(()=>validateNtfyReport(invalid)).toThrow('did not pass without skips');
  }
});

test('tool failure projection uses actual owned nonzero, deadline and spawn outcomes without private output',async()=>{
  const stage='ordinary release resource assembly';
  for(const [program,args,budget,outcome,exit]of [
    ['sh',['-c','printf "private-origin\n"; printf "Connection reset by peer\nprivate-key" >&2; exit 7'],2000,'nonzero-exit',7],
    ['sleep',['30'],20,'deadline',null],
    ['/owned/not-present/private-launcher',[],2000,'spawn-failed',null],
  ] as const) {
    const child=new OwnedProcess(program,[...args]);let original:unknown;
    try{await child.finish(stage,budget);}catch(error){original=error;}
    expect(original).toBeInstanceOf(Error);
    const observed=await ntfyToolFailure(stage,original,child,true);
    expect(observed.operation).toBe('release-resources');expect(observed.outcome).toBe(outcome);expect(observed.exit).toBe(exit);
    expect(observed.process.scope).toBe('after-finish-cleanup');
    expect(JSON.stringify(observed)).not.toMatch(/private|origin|private-launcher|Connection reset/);
    if(outcome==='nonzero-exit'){expect(observed.output.connectionReset).toBe(true);expect(observed.process.exitCode).toBe(7);}
    else expect(observed.output.unclassified).toBe(true);
    expect(child.stdout.length).toBeLessThanOrEqual(16*1024);expect(child.stderr.length).toBeLessThanOrEqual(16*1024);
  }
});

test('ownership, unknown callers and failed observers cannot project private error data or invented causes',async()=>{
  const original=new Error('private-path https://private-origin/token');
  const unstarted=await ntfyToolFailure('ordinary release resource assembly',original,undefined,false);
  expect(unstarted.outcome).toBe('ownership-check');expect(unstarted.ownershipCheckReturned).toBe(false);
  expect(unstarted.process.state).toBe('unavailable');
  const child=new OwnedProcess('sh',['-c','exit 0']);await child.finish('ordinary release resource assembly',2000);
  const observe=spyOn(child,'startupDiagnostic').mockRejectedValue(new Error('private-observer'));
  try {
    for(const error of [original,new Error('Owned fixture failed: ordinary release resource assembly; exit=999'),
      new Error('Owned fixture deadline: private-stage'),{message:'private-object'},
      Object.defineProperty(new Error('unused'),'message',{get(){throw new Error('private-getter');}})]) {
      const projected=await ntfyToolFailure('ordinary release resource assembly',error,child,true);
      expect(projected.outcome).toBe('unknown');expect(projected.process.state).toBe('unavailable');
      expect(projected.exit).toBeNull();expect(JSON.stringify(projected)).not.toMatch(/private|https|999|message/);
    }
    const unknown=await ntfyToolFailure('private-caller-path',new Error('Owned fixture deadline: private-caller-path'),child,true);
    expect(unknown.operation).toBe('unclassified');expect(unknown.outcome).toBe('unknown');
    expect(JSON.stringify(unknown)).not.toContain('private');
    expect((await ntfyToolFailure('__proto__',original,undefined,true)).operation).toBe('unclassified');
  }finally{observe.mockRestore();}
});

test('tool process metadata rejects malformed values and classifies only the retained output window',async()=>{
  const child=new OwnedProcess('sh',['-c','printf "Connection reset by peer"; head -c 20000 /dev/zero | tr "\\0" x; exit 9']);
  let failure:unknown;try{await child.finish('ordinary release resource assembly',2000);}catch(error){failure=error;}
  const state=spyOn(child,'startupDiagnostic').mockResolvedValue({state:'private-state',exitCode:999} as never);
  try {
    const result=await ntfyToolFailure('ordinary release resource assembly',failure,child,true);
    expect(result.outcome).toBe('nonzero-exit');expect(result.exit).toBe(9);
    expect(result.process).toEqual({scope:'after-finish-cleanup',state:'unavailable',exitCode:null});
    expect(result.output.connectionReset).toBe(false);expect(result.output.unclassified).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private|Connection|xxx/);
    const hostile=Object.defineProperty(child,'stdout',{configurable:true,get(){throw new Error('private-tail');}});
    await expect(ntfyToolFailure('ordinary release resource assembly',failure,hostile,true)).rejects.toThrow('private-tail');
    // The enclosing run helper treats a projection failure as optional and rethrows its original error.
  }finally{state.mockRestore();}
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

test('clock bookends retain only closed progress and window relations without raw timestamps',()=>{
  const text=clockDiagnostic.replace('clock=beforeIssued]','clock=beforeIssued hostProgress=consistentWithinSecond issuedInHandler=within postProgress=consistentWithinSecond callbackProgress=wallBehind postClock=beforeIssued]');
  expect(eventObservation(text)).toMatchObject({hostProgress:'consistentWithinSecond',issuedInHandler:'within',postProgress:'consistentWithinSecond',callbackProgress:'wallBehind',postClock:'beforeIssued'});
  expect(JSON.stringify(eventObservation(text))).not.toMatch(/[0-9]|issuedAt|elapsedRealtime|private/);
  for(const key of ['hostProgress','postProgress','callbackProgress']) {
    for(const category of ['consistentWithinSecond','wallAhead','wallBehind','unavailable']) {
      const changed=text.replace(new RegExp(`${key}=[a-zA-Z]+`),`${key}=${category}`);
      expect(eventObservation(changed)?.[key as keyof NonNullable<ReturnType<typeof eventObservation>>]).toBe(category);
    }
  }
  for(const category of ['within','outside','unavailable'])expect(eventObservation(text.replace('issuedInHandler=within',`issuedInHandler=${category}`))?.issuedInHandler).toBe(category);
  for(const category of ['unavailable','beforeIssued','withinWindow','expired'])expect(eventObservation(text.replace('postClock=beforeIssued',`postClock=${category}`))?.postClock).toBe(category);
  for(const bad of [text.replace('hostProgress=consistentWithinSecond','hostProgress=private'),text.replace('postProgress=consistentWithinSecond','postProgress=1000'),text.replace('issuedInHandler=within','issuedInHandler=within issuedAt=1000'),text.replace(' postClock=beforeIssued',''),text.replace('postClock=beforeIssued]','postClock=beforeIssued elapsedRealtime=1000]'),text+text])expect(eventObservation(bad)).toBeUndefined();
});
