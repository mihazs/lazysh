import {expect,test} from 'bun:test';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {androidTerminalCoreAcceptance,keepDeviceEvidence,validateTerminalCoreReport} from './support/androidTerminalCore';

const core='app.lazysh.client.NativeTerminalCoreTest',composition='app.lazysh.client.NativeTerminalCompositionTest';
const cases:[string,string][]=[[core,'theCoreInsideTheAppParsesTheOutputOfARealShellAndReadsItBack'],[core,'theProbeRefusesASoftwareRasterizerUnlessTheDebugSwitchAllowsOne'],
  [composition,'thePageShowsTheSurfaceThroughItsNativePaneWithItsOverlayAboveAndTheWebViewIsOpaqueAgainWhenItEnds'],[composition,'aPlacedSurfaceChangesNothingOnAPageThatIsNotANativePane'],
  [composition,'aRecreatedActivityStartsOpaqueAndShowsTheSurfaceAgainOnceItsPagePlacesIt']];
const report=(rows:string[])=>`<?xml version="1.0"?><testsuites><testsuite tests="${rows.length}">${rows.join('')}</testsuite></testsuites>`;
const row=([className,name]:[string,string],body='')=>`<testcase name="${name}" classname="${className}" time="1">${body}</testcase>`;
const all=(change:(entry:[string,string],index:number)=>string[]=entry=>[row(entry)])=>cases.flatMap(change);

test('the terminal core report counts only its cases, each passing exactly once',()=>{
  expect(()=>validateTerminalCoreReport(report(all()))).not.toThrow();
  const bad:string[][]=[[],[row(cases[0])],all().slice(1)];
  cases.forEach((entry,at)=>{
    const only=(variant:(entry:[string,string])=>string[])=>all((each,index)=>index===at?variant(each):[row(each)]);
    bad.push(only(()=>[]),only(each=>[row(each),row(each)]),only(each=>[row(each,'<skipped/>')]),only(each=>[row(each,'<failure message="x"/>')]),
      only(each=>[row(each,'<error message="x"/>')]),only(([className,name])=>[row([className,name+'Other'])]),only(([,name])=>[row(['app.lazysh.client.NativeWorkspaceTest',name])]));
  });
  for(const rows of bad)expect(()=>validateTerminalCoreReport(report(rows))).toThrow('did not pass exactly once');
});

test('the evidence the cases left on the device is kept with the results and nothing else is',async()=>{
  const destination=await mkdtemp(join(tmpdir(),'lazysh-evidence-'));
  const files:Record<string,string>={'native-probe.json':'{"shippingPolicy":{"available":false}}\n','surface.png':'png bytes','notes.txt':'not json evidence'};
  const calls:string[][]=[];
  const device=async(args:string[])=>{
    calls.push(args);
    if(args[1]==='ls')return Object.keys(files).join('\n')+'\n';
    return files[args[2].split('/').pop()!];
  };
  try {
    expect(await keepDeviceEvidence(device,destination)).toEqual(['native-probe.json','surface.png']);
    // A picture is pulled from the device, not read as text.
    expect(calls.filter(call=>call[0]==='pull')).toEqual([['pull','/data/local/tmp/lazysh-evidence/surface.png',join(destination,'surface.png')]]);
    expect(await readdir(destination)).toEqual(['native-probe.json']);
    expect(JSON.parse(await readFile(join(destination,'native-probe.json'),'utf8')).shippingPolicy.available).toBe(false);
    // A device with nothing left (a run that crashed first) is an empty answer, not a failure of the harness.
    expect(await keepDeviceEvidence(async()=>{throw new Error('no such directory');},destination)).toEqual([]);
    // What the device returns must be JSON: a truncated write is refused, not kept.
    files['native-probe.json']='{"shipping';
    await expect(keepDeviceEvidence(device,destination)).rejects.toThrow();
  } finally {await rm(destination,{recursive:true,force:true});}
});

test('the shared Android runtime job leaves the terminal core case to the job that builds the feature and has the fixture',async()=>{
  const moon=Bun.YAML.parse(await readFile(join(import.meta.dir,'../apps/client/moon.yml'),'utf8')) as {tasks:Record<string,{script:string}>};
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalCoreTest');
});

// The case needs the x86_64 debug APK built with the native-terminal feature and an explicitly selected emulator or Waydroid guest.
test.skipIf(process.env.LAZYSH_ANDROID_UI_TERMINAL_CORE!=='1')('actual Android app parses the output of a real shell in its terminal core and reads it back through the IPC',async()=>{
  await androidTerminalCoreAcceptance();
},1_000_000);
