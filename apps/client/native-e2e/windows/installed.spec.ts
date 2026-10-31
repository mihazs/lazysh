import {afterEach,expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {writeFile,readFile,unlink,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {remote} from 'webdriverio';
import {parseWindowsGuiOwner,windowsGuiCapabilities,windowsGuiOwnerScript,windowsGuiSessionResponse,windowsGuiSessionNoResponse,windowsGuiProbeDiagnostic,windowsGuiSessionHealth,windowsGuiHealthOwnerScript,windowsGuiStartupProbe,windowsGuiAccessibilitySource} from '../../../../.changeset/windows-installed-gui';
import {assertDirectDriverEnvironment} from '../policy';

let browser:Awaited<ReturnType<typeof remote>>|undefined;
afterEach(async()=>{if(browser){const owned=browser;browser=undefined;await owned.deleteSession();}});
it.skipIf(process.platform!=='win32')('opens the exact installed bundled application in its owned native window',async()=>{
  if(process.env.LAZYSH_TEST_WINDOWS_GUI!=='1'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('Installed GUI requires explicitly owned Windows CI');
  assertDirectDriverEnvironment(process.env);
  const port=Number(process.env.LAZYSH_GUI_PORT),sha=process.env.GITHUB_SHA??'',version=process.env.LAZYSH_VERSION??'';
  if(!Number.isInteger(port)||port<1||port>65535||!/^[a-f0-9]{40}$/.test(sha)||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid installed GUI invocation');
  const requireStandard=process.env.LAZYSH_GUI_REQUIRE_STANDARD==='1';
  let startup:ReturnType<typeof windowsGuiStartupProbe>['startup'];
  const owner=async(diagnostic=false,accessibility=false)=>{
    let core:unknown;
    try {
      const observe=accessibility&&Buffer.byteLength(windowsGuiAccessibilitySource)<=65536;
      const pending=promisify(execFile)('pwsh.exe',['-NoProfile','-NonInteractive','-Command',windowsGuiOwnerScript],{timeout:15000,maxBuffer:16384,env:{...process.env,LAZYSH_GUI_STARTUP_PROBE:diagnostic?'1':'0',LAZYSH_GUI_ACCESSIBILITY_PROBE:observe?'1':'0'}});
      // Optional diagnostic input cannot replace already emitted native ownership proof.
      pending.child.stdin?.on('error',()=>{});pending.child.stdin?.end(observe?windowsGuiAccessibilitySource:undefined);
      const result=await pending.catch(error=>{if(!diagnostic)throw error;return {stdout:typeof error.stdout==='string'?error.stdout:''};});
      core=result.stdout;
      if(diagnostic){const projected=windowsGuiStartupProbe(core);core=projected.core;startup=projected.startup??{available:false,overflow:false,signature:'UNVERIFIED'};}
      return parseWindowsGuiOwner(typeof core==='string'?core.trim():'',process.env.LAZYSH_NSIS_BINARY_SHA256??'');
    } catch(error) {throw new Error('Installed GUI native window/image ownership rejected',{cause:windowsGuiProbeDiagnostic(core??(error as {stdout?:unknown}).stdout)});}
  };
  const capabilities=windowsGuiCapabilities(process.env.LAZYSH_GUI_BINARY!,process.env.LAZYSH_GUI_COUNTERFACTUAL);
  let stage=requireStandard?'GUI_MEDIUM_UNAVAILABLE':'GUI_SESSION';
  let session:ReturnType<typeof windowsGuiSessionResponse>|undefined;
  try {
  if(requireStandard){
    const roots=JSON.parse(process.env.LAZYSH_GUI_MEDIUM_ROOTS??'null');
    if(!Array.isArray(roots)||roots.length!==3||!roots.every(root=>typeof root==='string'))throw new Error('Invalid private workspace');
    for(const root of roots){
      const directory=await lstat(root);if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('Private workspace unavailable');
      const proof=join(root,'medium-write-'+randomUUID());let owned=false;
      try{await writeFile(proof,'owned-medium-write',{flag:'wx'});owned=true;if(await readFile(proof,'utf8')!=='owned-medium-write')throw new Error('Private workspace unavailable');}
      finally{if(owned)await unlink(proof);}
    }
  }
  stage='GUI_SESSION';
  browser=await remote({hostname:'127.0.0.1',port,path:'/',logLevel:'silent',connectionRetryCount:0,connectionRetryTimeout:20000,
    capabilities,transformResponse:response=>{if(stage==='GUI_SESSION')session=windowsGuiSessionResponse(response);return response;}});
  let admitted:Awaited<ReturnType<typeof owner>>|undefined;
  if(requireStandard){stage='GUI_OWNER';admitted=await owner(true);if(!startup?.available||startup.appIntegrity!=='MEDIUM'||startup.appElevation!=='NOT_ELEVATED')throw new Error('Standard context unverified');}
  stage='GUI_FRONTEND';
  expect(['http://tauri.localhost/','https://tauri.localhost/','tauri://localhost/']).toContain(await browser.getUrl());
  expect(await browser.getWindowHandles()).toHaveLength(1);
  const about=await browser.$(`button=About lazysh · ${version}`);await about.waitForDisplayed({timeout:30000});
  stage='GUI_OWNER';
  const original=admitted??await owner();
  stage='GUI_VERSION';
  await about.click();
  const panel=await browser.$('.about-panel');await panel.waitForDisplayed();
  expect(await panel.getText()).toContain(version);
  expect(await (await panel.$('code')).getText()).toBe(sha);
  stage='GUI_OWNER';
  expect(await owner(requireStandard)).toEqual(original);
  if(requireStandard&&(!startup?.available||startup.appIntegrity!=='MEDIUM'||startup.appElevation!=='NOT_ELEVATED'))throw new Error('Standard context retired');
  // These are synthetic test identities only; no DOM/profile/desktop capture is retained.
  await writeFile(process.env.LAZYSH_GUI_RECEIPT!,JSON.stringify({...original,source:sha,version,...(requireStandard?{startup}: {})}),{flag:'wx'});
  } catch(error) {
    const failure: {failure:string;session?:ReturnType<typeof windowsGuiSessionResponse>;ownedWindow?:'VERIFIED'|'UNVERIFIED';probe?:ReturnType<typeof windowsGuiProbeDiagnostic>['phase'];roleMask?:number;metadata?:ReturnType<typeof windowsGuiProbeDiagnostic>['metadata'];proxyHealth?:string;nativeHealth?:string;startup?:ReturnType<typeof windowsGuiStartupProbe>['startup']}={failure:stage};
    if(stage==='GUI_SESSION') {
      const health=await windowsGuiSessionHealth([port,Number(process.env.LAZYSH_GUI_NATIVE_PORT)],async()=>{
        const verified=await promisify(execFile)('pwsh.exe',['-NoProfile','-NonInteractive','-Command',windowsGuiHealthOwnerScript],{timeout:10000,maxBuffer:1024});
        if(verified.stdout!=='VERIFIED')throw new Error('Unverified health ownership');
      });
      failure.proxyHealth=health.proxy;failure.nativeHealth=health.native;
      failure.session=session??windowsGuiSessionNoResponse(error,port);
      try {await owner(true,!requireStandard);failure.ownedWindow='VERIFIED';}
      catch(probe) {
        failure.ownedWindow='UNVERIFIED';
        const diagnostic=probe instanceof Error ? probe.cause as ReturnType<typeof windowsGuiProbeDiagnostic> : undefined;
        failure.probe=diagnostic?.phase??'PROBE_UNVERIFIED';failure.roleMask=diagnostic?.roleMask;failure.metadata=diagnostic?.metadata;
      }
      failure.startup=startup??{available:false,overflow:false,signature:'UNVERIFIED'};
    }
    if(requireStandard&&startup)failure.startup=startup;
    await writeFile(process.env.LAZYSH_GUI_RECEIPT!,JSON.stringify(failure),{flag:'wx'});
    throw new Error(`Installed GUI rejected: ${stage}`);
  }
},90000);
