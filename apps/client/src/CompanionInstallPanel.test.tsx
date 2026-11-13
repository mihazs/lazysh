// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
const install=vi.hoisted(()=>vi.fn());
const fromDevice=vi.hoisted(()=>vi.fn());
const rollback=vi.hoisted(()=>vi.fn());
const check=vi.hoisted(()=>vi.fn());
vi.mock('./bridge',()=>({api:{installCompanion:install,installCompanionFromDevice:fromDevice,rollbackCompanion:rollback,checkCompanionUpdate:check}}));
import CompanionInstallPanel,{companionInstallStage,companionInstallProgress,companionInstallFailure,parseCompanionInstall,parseCompanionCheck} from './CompanionInstallPanel';
import {applyAccessStatus} from './access';
import {uiI18n} from './i18n/core';
const result={schemaVersion:1,status:'installed',version:'1.0.0',path:'/owned/lazysh-agent',cleanup:'complete'};
let generation=0;
beforeEach(async()=>{install.mockReset();fromDevice.mockReset();rollback.mockReset();check.mockReset();await uiI18n.changeLanguage('en');applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++generation),nonce:'a'.repeat(64)});});
afterEach(()=>cleanup());

it('accepts only finite progress and complete installation results',()=>{
  expect(companionInstallStage({stage:'uploading'})).toBe('uploading');
  for(const value of [null,{stage:'private-host-message'},{stage:'uploading',path:'/private'},{stage:'constructor'}])expect(companionInstallStage(value)).toBeUndefined();
  expect(parseCompanionInstall(result)).toEqual(result);
  for(const path of ['/owned/世界 agent','C:\\Users\\owned\\agent.exe','\\\\server\\share\\agent.exe'])expect(parseCompanionInstall({...result,path}).path).toBe(path);
  expect(parseCompanionInstall({...result,status:'reused',cleanup:'residue'}).status).toBe('reused');
  for(const reason of ['committedDurabilityUnknown','commitResponseLost','verificationUnavailable'])expect(parseCompanionInstall({...result,status:'uncertain',reason}).status).toBe('uncertain');
  for(const patch of [{schemaVersion:2},{status:'complete'},{version:'1.0.0-beta'},{path:'relative'},{path:'/owned\nprivate'},{path:'/'.repeat(4097)},{cleanup:'unknown'},{status:'uncertain'},{reason:'commitResponseLost'},{status:'uncertain',reason:'private-message'},{bytes:[1,2,3]}])expect(()=>parseCompanionInstall({...result,...patch})).toThrow('Invalid companion installation response.');
});

function pendingInstall() {
  const requests:{progress:(value:unknown)=>void;finish:(value:unknown)=>void;fail:(error:unknown)=>void}[]=[];
  install.mockImplementation((_source:string,progress:(value:unknown)=>void)=>new Promise((finish,fail)=>requests.push({progress,finish,fail})));
  return requests;
}
it('keeps a stable action while the installed result precedes asynchronous snapshot readiness',async()=>{
  const requests=pendingInstall(),refreshed=vi.fn();
  const view=render(<CompanionInstallPanel sessionId="owned" ready={false} onInstalled={refreshed}/>);
  const selector='details.companion-install > .tool-bar > button';
  const button=document.querySelector(selector)!;
  fireEvent.click(button);
  await act(async()=>{requests[0].finish(result);});
  expect(refreshed).toHaveBeenCalledTimes(1);
  expect(document.querySelector('details')?.getAttribute('data-install-outcome')).toBe('installed');
  expect(document.evaluate("//details[contains(@class,'companion-install')]//button[normalize-space(.)='Update companion']",document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue).toBeNull();
  expect(document.querySelector(selector)).toBe(button);
  expect(button.textContent).toBe('Install companion');
  expect(install).toHaveBeenCalledTimes(1);
  view.rerender(<CompanionInstallPanel sessionId="owned" ready onInstalled={refreshed}/>);
  expect(document.querySelector(selector)).toBe(button);
  expect(button.textContent).toBe('Update companion');
  expect(button).not.toHaveProperty('disabled',true);
  expect(install).toHaveBeenCalledTimes(1);
  fireEvent.click(button);
  await act(async()=>{requests[1].finish({...result,status:'reused'});});
  expect(document.querySelector('details')?.getAttribute('data-install-outcome')).toBe('reused');
});
it('accepts only closed cleanup failure pairs on residue and retires their observation with the result',async()=>{
  const cleanupFailure={stage:'verifyFile',reason:'timeout'};
  const residue={...result,cleanup:'residue',cleanupFailure};
  expect(parseCompanionInstall(residue)).toEqual(residue);
  for(const detail of [null,[],{stage:'verifyFile',reason:'private error'},{stage:'removeDirectory',reason:'hash'},{stage:'constructor',reason:'request'},{...cleanupFailure,path:'/private'},undefined])
    expect(()=>parseCompanionInstall({...residue,cleanupFailure:detail})).toThrow('Invalid companion installation response.');
  expect(()=>parseCompanionInstall({...result,cleanupFailure})).toThrow('Invalid companion installation response.');
  const requests=pendingInstall();const view=render(<CompanionInstallPanel sessionId="owned" onInstalled={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));
  await act(async()=>{requests[0].finish(residue);});
  const panel=document.querySelector('details')!;
  expect(panel.getAttribute('data-install-cleanup-stage')).toBe('verifyFile');
  expect(panel.getAttribute('data-install-cleanup-reason')).toBe('timeout');
  expect(screen.getByText('Some temporary installation files remain on the host.')).toBeTruthy();
  view.rerender(<CompanionInstallPanel sessionId="replacement" onInstalled={()=>{}}/>);
  expect(panel.getAttribute('data-install-cleanup-stage')).toBe('none');
  expect(panel.getAttribute('data-install-cleanup-reason')).toBe('none');
});
it('requires an explicit action, coalesces clicks, reports progress and refreshes only after verified completion',async()=>{
  const requests=pendingInstall(),installed=vi.fn();render(<CompanionInstallPanel sessionId="ssh-owned" onInstalled={installed}/>);
  expect(install).not.toHaveBeenCalled();
  const button=screen.getByRole('button',{name:'Install companion'});fireEvent.click(button);fireEvent.click(button);
  expect(install).toHaveBeenCalledTimes(1);expect(install.mock.calls[0][0]).toBe('ssh-owned');
  act(()=>requests[0].progress({stage:'uploading'}));expect(screen.getByText('Transferring the companion…')).toBeTruthy();
  act(()=>requests[0].progress({stage:'private-message',path:'private-path'}));expect(screen.queryByText('private-message')).toBeNull();
  await act(async()=>{requests[0].finish(result);});expect(installed).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Installed host companion 1.0.0.')).toBeTruthy();expect(button).not.toHaveProperty('disabled',true);
  act(()=>requests[0].progress({stage:'installing'}));expect(screen.queryByText('Installing the host companion…')).toBeNull();
});

it.each(['committedDurabilityUnknown','commitResponseLost','verificationUnavailable'])('keeps %s uncertain without reporting success or hiding residue',async reason=>{
  install.mockResolvedValue({...result,status:'uncertain',reason,cleanup:'residue'});
  const installed=vi.fn();render(<CompanionInstallPanel sessionId="ssh-uncertain" ready onInstalled={installed}/>);
  const summary=screen.getByText('Host companion installation');expect(summary.closest('details')).toHaveProperty('open',false);
  fireEvent.click(summary);expect(summary.closest('details')).toHaveProperty('open',true);
  fireEvent.click(screen.getByRole('button',{name:'Update companion'}));await act(async()=>{});
  expect(installed).not.toHaveBeenCalled();expect(screen.getByText('The installation could not be confirmed. Retry to check it again.')).toBeTruthy();
  expect(screen.getByText('Some temporary installation files remain on the host.')).toBeTruthy();
});

it('retires old-source progress and completion without unlocking the current pending request',async()=>{
  const requests=pendingInstall(),installed=vi.fn();const view=render(<CompanionInstallPanel sessionId="old-source" onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));
  view.rerender(<CompanionInstallPanel sessionId="new-source" onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));expect(requests).toHaveLength(2);
  await act(async()=>{requests[0].progress({stage:'cleaningUp'});requests[0].finish(result);});
  expect(screen.queryByText('Finishing…')).toBeNull();expect(installed).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Installing…'})).toHaveProperty('disabled',true);
  await act(async()=>{requests[1].finish({...result,path:'/new-host/agent'});});
  expect(installed).toHaveBeenCalledTimes(1);expect(screen.getByText('/new-host/agent')).toBeTruthy();
});

it.each(['hide','unmount','lock'])('does not publish completion after %s',async mode=>{
  const requests=pendingInstall(),installed=vi.fn();const view=render(<CompanionInstallPanel sessionId="retired" onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));
  if(mode==='hide')view.rerender(<CompanionInstallPanel sessionId="retired" visible={false} onInstalled={installed}/>);
  else if(mode==='unmount')view.unmount();
  else act(()=>applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(++generation)}));
  await act(async()=>{requests[0].progress({stage:'checkingInstalled'});requests[0].finish(result);});
  expect(installed).not.toHaveBeenCalled();expect(screen.queryByText('Installed host companion 1.0.0.')).toBeNull();
});

it('keeps host paths inert and treats malformed results as localized errors',async()=>{
  install.mockResolvedValue({...result,path:'/owned/<img src=x onerror=alert(1)>'});
  const installed=vi.fn();render(<CompanionInstallPanel sessionId="literal" onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  expect(document.querySelector('img')).toBeNull();expect(screen.getByText('/owned/<img src=x onerror=alert(1)>')).toBeTruthy();
  install.mockResolvedValue({...result,reason:'invalid-extra-reason'});
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  expect(installed).toHaveBeenCalledTimes(1);expect(screen.getByRole('alert').textContent).toBe('Invalid companion installation response.');
  await act(async()=>{await uiI18n.changeLanguage('es');});expect(screen.getByRole('alert').textContent).toBe('Respuesta de instalación del companion no válida.');
});

it.each([
  ['companion_install_busy','Installation is already running on this connection.'],
  ['companion_install_unsupported','Installation is not supported on this host platform yet.'],
  ['companion_release_unavailable','The current release has no compatible companion available.'],
  ['companion_newer_installed','The host already has a newer companion. It has been preserved.'],
])('shows the native %s outcome without interpreting host error text',async(kind,message)=>{
  install.mockRejectedValue({kind,message:'Native diagnostic text'});const installed=vi.fn();
  render(<CompanionInstallPanel sessionId="rejected" onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  expect(screen.getByRole('alert').textContent).toBe(message);expect(installed).not.toHaveBeenCalled();
});

it('retains the native failed phase across cleanup and synchronous settlement before a GUI poll',async()=>{
  install.mockImplementation((_source:string,progress:(value:unknown)=>void)=>{
    progress({stage:'uploading'});progress({stage:'cleaningUp'});
    return Promise.reject({kind:'ssh_error',phase:'uploading',message:'Existing user-visible error'});
  });
  render(<CompanionInstallPanel sessionId="fast-failure" onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  const panel=screen.getByText('Host companion installation').closest('details')!;
  expect(panel.dataset).toMatchObject({installPhase:'uploading',installFailure:'ssh_error',installOutcome:'failed',installReason:'none'});
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe('Existing user-visible error');
  install.mockRejectedValue({kind:'companion_install_busy',phase:null,message:'busy'});
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  expect(panel.dataset).toMatchObject({installPhase:'preflight',installFailure:'companion_install_busy',installOutcome:'failed'});
});

it('projects unknown error payloads to finite values without adding private diagnostic attributes',async()=>{
  const marker='/private/host/error-secret';
  expect(companionInstallFailure({kind:marker,phase:marker,message:marker,detail:marker})).toEqual({failure:'other',phase:undefined,detail:'none'});
  expect(companionInstallFailure({kind:'constructor',phase:'cleaningUp'})).toEqual({failure:'other',phase:undefined,detail:'none'});
  install.mockRejectedValue({kind:marker,phase:marker,message:'Existing message'});
  render(<CompanionInstallPanel sessionId="unknown-failure" onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  const panel=screen.getByText('Host companion installation').closest('details')!;
  expect(panel.dataset).toMatchObject({installPhase:'unavailable',installFailure:'other',installOutcome:'failed'});
  expect(Array.from(panel.attributes).filter(attribute=>attribute.name.startsWith('data-install-')).map(attribute=>attribute.value).join(' ')).not.toContain(marker);
});

it('retires pending failure observations with their source and ignores late cleanup events',async()=>{
  const requests=pendingInstall(),installed=vi.fn();
  const view=render(<CompanionInstallPanel sessionId="before" onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));
  act(()=>requests[0].progress({stage:'verifying'}));
  view.rerender(<CompanionInstallPanel sessionId="after" onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));
  await act(async()=>{requests[0].fail({kind:'ssh_error',phase:'verifying',message:'Retired error'});requests[0].progress({stage:'cleaningUp'});});
  const panel=screen.getByText('Host companion installation').closest('details')!;
  expect(panel.dataset).toMatchObject({installPhase:'unavailable',installFailure:'none',installOutcome:'pending'});
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async()=>requests[1].finish({...result,status:'uncertain',reason:'verificationUnavailable'}));
  expect(panel.dataset).toMatchObject({installPhase:'checkingInstalled',installFailure:'none',installOutcome:'uncertain',installReason:'verificationUnavailable'});
  expect(installed).not.toHaveBeenCalled();
});

it('projects only complete tag recheck codes at the matching native failure boundary',async()=>{
  const base={kind:'companion_release_unavailable',phase:'verifying'};
  const codes=['body','json','ref','type','sha','status:100','status:403','status:429','status:599','status:other',
    ...['timeout','connect','redirect','body','decode','request','other'].map(value=>`transport:${value}`)];
  for(const code of codes){
    const message=`lazysh-tag-recheck-v1:${code}`;
    expect(companionInstallFailure({...base,message}).recheck).toBe(message);
  }
  for(const value of [
    ...['status:099','status:600','status:2000','status:0403','status:NaN','transport:private','unknown',
      'status:403 /private/host','status:403\n','ref\nprivate'].map(code=>({...base,message:`lazysh-tag-recheck-v1:${code}`})),
    {...base,message:'lazysh-tag-recheck-v1:ref',kind:'ssh_error'},
    {...base,message:'lazysh-tag-recheck-v1:ref',phase:'checkingRelease'},
    {...base,message:'lazysh-tag-recheck-v1:ref',phase:null},
    {...base,message:{toString:()=> 'lazysh-tag-recheck-v1:ref'}}
  ])expect(companionInstallFailure(value).recheck).toBeUndefined();
  install.mockRejectedValue({...base,message:'lazysh-tag-recheck-v1:status:403'});
  render(<CompanionInstallPanel sessionId="recheck-failure" onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  const panel=screen.getByText('Host companion installation').closest('details')!;
  expect(panel.dataset.installRecheck).toBe('lazysh-tag-recheck-v1:status:403');
  expect(screen.getByRole('alert').textContent).toBe('The current release has no compatible companion available.');
  install.mockRejectedValue({...base,message:'lazysh-tag-recheck-v1:status:403 /private/host'});
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  expect(panel.hasAttribute('data-install-recheck')).toBe(false);
  expect(panel.textContent).not.toContain('/private/host');
});

it('accepts the host download counts only on the downloading stage and only within the declared total',()=>{
  expect(companionInstallProgress({stage:'downloading',bytes:5,total:9})).toEqual({stage:'downloading',bytes:5,total:9});
  expect(companionInstallProgress({stage:'selfTesting'})).toEqual({stage:'selfTesting'});
  for(const value of [{stage:'verifying',bytes:5,total:9},{stage:'downloading',bytes:10,total:9},{stage:'downloading',bytes:-1,total:9},{stage:'downloading',bytes:1.5,total:9},{stage:'downloading',bytes:'5',total:9},{stage:'downloading',bytes:5},{stage:'downloading',bytes:5,total:9,path:'/private'},{stage:'constructor',bytes:1,total:2}])
    expect(companionInstallProgress(value)).toBeUndefined();
});
it('updates through the host route, shows what the host reports and never touches the device download',async()=>{
  const requests=pendingInstall(),installed=vi.fn();render(<CompanionInstallPanel sessionId="host-route" ready onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Update companion'}));
  act(()=>requests[0].progress({stage:'downloading'}));expect(screen.getByText('The host is downloading the companion…')).toBeTruthy();
  act(()=>requests[0].progress({stage:'downloading',bytes:3_145_728,total:11_534_336}));expect(screen.getByText('The host is downloading the companion: 3 of 11 MB')).toBeTruthy();
  act(()=>requests[0].progress({stage:'selfTesting'}));expect(screen.getByText('Testing the companion on the host…')).toBeTruthy();
  await act(async()=>{requests[0].finish(result);});
  expect(installed).toHaveBeenCalledTimes(1);expect(fromDevice).not.toHaveBeenCalled();
  expect(document.querySelector('details')?.dataset).toMatchObject({installRoute:'host',installOutcome:'installed'});
  expect(screen.queryByText('Install through this device')).toBeNull();
});
it.each([
  ['companion_host_network','dns','The host could not download the companion from GitHub. It needs outbound HTTPS access.'],
  ['companion_host_tool_missing','noDownloader','The host has no curl or GNU wget, or no SHA-256 tool, so it cannot download the companion.'],
])('offers the labelled device fallback after %s and only then installs through the device',async(kind,detail,message)=>{
  install.mockRejectedValue({kind,detail,phase:'downloading',message:'Private remote text'});fromDevice.mockResolvedValue({...result,status:'installed'});
  const installed=vi.fn();render(<CompanionInstallPanel sessionId="offline-host" onInstalled={installed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  expect(screen.getByRole('alert').textContent).toBe(message);
  const panel=screen.getByText('Host companion installation').closest('details')!;
  expect(panel.dataset).toMatchObject({installFailure:kind,installDetail:detail,installRoute:'host',installOutcome:'failed'});
  expect(screen.getByText(/download it on this device/)).toBeTruthy();expect(fromDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Install through this device'}));await act(async()=>{});
  expect(fromDevice).toHaveBeenCalledTimes(1);expect(fromDevice.mock.calls[0][0]).toBe('offline-host');expect(install).toHaveBeenCalledTimes(1);
  expect(installed).toHaveBeenCalledTimes(1);expect(panel.dataset).toMatchObject({installRoute:'device',installOutcome:'installed'});
  expect(screen.queryByText('Install through this device')).toBeNull();
});
it.each([
  ['companion_verification_failed','The file the host downloaded did not match the release and was discarded. Nothing was installed.'],
  ['companion_self_test_failed','The downloaded companion failed its self test. The installed companion was not changed.'],
  ['companion_rolled_back','The new companion failed after installation, so the previous one was restored.'],
  ['companion_host_busy','Another companion update is running on this host.'],
  ['companion_unsafe_location','The companion location on this host is not safe to use, so nothing was changed.'],
  ['companion_newer_installed','The host already has a newer companion. It has been preserved.'],
  ['companion_install_timeout',undefined],
])('does not offer the device download after the host reported %s',async(kind,message)=>{
  install.mockRejectedValue({kind,detail:'digestMismatch',phase:'verifying',message:'Native diagnostic text'});
  render(<CompanionInstallPanel sessionId="refused" onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  if(message)expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.queryByText('Install through this device')).toBeNull();expect(fromDevice).not.toHaveBeenCalled();
});
it('keeps the fallback out of a device-route failure and retires it with its source',async()=>{
  install.mockRejectedValue({kind:'companion_host_network',phase:'downloading',message:'x'});fromDevice.mockRejectedValue({kind:'companion_host_network',phase:'downloading',message:'x'});
  const view=render(<CompanionInstallPanel sessionId="first-host" onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  fireEvent.click(screen.getByRole('button',{name:'Install through this device'}));await act(async()=>{});
  expect(screen.queryByText('Install through this device')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Install companion'}));await act(async()=>{});
  expect(screen.getByText('Install through this device')).toBeTruthy();
  view.rerender(<CompanionInstallPanel sessionId="second-host" onInstalled={vi.fn()}/>);
  expect(screen.queryByText('Install through this device')).toBeNull();
});
it.each([['pt-BR','Instalar por este dispositivo'],['es','Instalar desde este dispositivo']])('shows the labelled fallback in %s',async(language,label)=>{
  await uiI18n.changeLanguage(language);
  install.mockRejectedValue({kind:'companion_host_tool_missing',phase:'verifying',message:'x'});
  render(<CompanionInstallPanel sessionId={`locale-${language}`} onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Instalar companion'}));await act(async()=>{});
  expect(screen.getByRole('button',{name:label})).toBeTruthy();
});

const checked={schemaVersion:1,via:'update',installed:'1.54.1',previous:'1.50.0',latest:'1.55.0',state:'available'};
it('accepts only a complete check made of versions and a closed state',()=>{
  expect(parseCompanionCheck(checked)).toEqual(checked);
  expect(parseCompanionCheck({...checked,via:'bootstrap',installed:null,previous:null,state:'notInstalled'}).installed).toBeNull();
  for(const patch of [{schemaVersion:2},{via:'script'},{state:'maybe'},{latest:'1.55'},{latest:null},{installed:'1.54.1-dev'},{previous:'/private'},{installed:undefined},{extra:'/private/host'}])
    expect(()=>parseCompanionCheck({...checked,...patch})).toThrow('Invalid companion installation response.');
  expect(()=>parseCompanionCheck(null)).toThrow('Invalid companion installation response.');
});
it.each([
  ['available','Host companion 1.54.1 can be updated to 1.55.0.'],
  ['upToDate','Host companion 1.54.1 is up to date.'],
  ['newer','Host companion 1.54.1 is newer than the latest release, 1.55.0.'],
])('checks for updates without installing and says when the host is %s',async(state,message)=>{
  check.mockResolvedValue({...checked,state});
  render(<CompanionInstallPanel sessionId="checking" ready onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Check for updates'}));
  expect(screen.getByRole('button',{name:'Checking…'})).toHaveProperty('disabled',true);
  await act(async()=>{});
  expect(screen.getByText(message)).toBeTruthy();expect(check).toHaveBeenCalledWith('checking');
  expect(install).not.toHaveBeenCalled();expect(fromDevice).not.toHaveBeenCalled();expect(rollback).not.toHaveBeenCalled();
});
it('names a host without a companion and offers no rollback when none is kept',async()=>{
  check.mockResolvedValue({...checked,via:'bootstrap',installed:null,previous:null,state:'notInstalled'});
  render(<CompanionInstallPanel sessionId="empty-host" onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Check for updates'}));await act(async()=>{});
  expect(screen.getByText('No host companion is installed. 1.55.0 is available.')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/Roll back/})).toBeNull();
});
it('rolls back to the kept previous companion only after a check found one, and reports the restored version',async()=>{
  check.mockResolvedValue(checked);const requests=[] as {progress:(value:unknown)=>void;finish:(value:unknown)=>void}[];
  rollback.mockImplementation((_id:string,progress:(value:unknown)=>void)=>new Promise(finish=>requests.push({progress,finish})));
  const installed=vi.fn();render(<CompanionInstallPanel sessionId="rollback-host" ready onInstalled={installed}/>);
  expect(screen.queryByRole('button',{name:/Roll back/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Check for updates'}));await act(async()=>{});
  fireEvent.click(screen.getByRole('button',{name:'Roll back to 1.50.0'}));
  expect(rollback).toHaveBeenCalledTimes(1);expect(install).not.toHaveBeenCalled();
  act(()=>requests[0].progress({stage:'installing'}));expect(screen.getByText('Installing the host companion…')).toBeTruthy();
  await act(async()=>{requests[0].finish({...result,status:'rolledBack',version:'1.50.0'});});
  expect(screen.getByText('Restored host companion 1.50.0.')).toBeTruthy();expect(installed).toHaveBeenCalledTimes(1);
  expect(document.querySelector('details')?.dataset).toMatchObject({installRoute:'rollback',installOutcome:'rolledBack'});
  expect(screen.queryByRole('button',{name:/Roll back/}),'the kept companion is consumed until the next check').toBeNull();
});
it.each([
  ['companion_no_previous','The host has no previous companion to restore.'],
  ['companion_update_unsupported',"This host's companion cannot roll itself back yet. Update it first."],
  ['companion_rolled_back','The new companion failed after installation, so the previous one was restored.'],
])('reports %s from a rollback without offering the device download',async(kind,message)=>{
  check.mockResolvedValue(checked);rollback.mockRejectedValue({kind,phase:null,message:'Native diagnostic text'});
  render(<CompanionInstallPanel sessionId="rollback-refused" onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Check for updates'}));await act(async()=>{});
  fireEvent.click(screen.getByRole('button',{name:'Roll back to 1.50.0'}));await act(async()=>{});
  expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.queryByText('Install through this device')).toBeNull();expect(fromDevice).not.toHaveBeenCalled();
});
it('keeps actions exclusive while an operation runs, retires a check with its source and surfaces check failures',async()=>{
  let finish!:(value:unknown)=>void;check.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<CompanionInstallPanel sessionId="first" ready onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Check for updates'}));
  expect(screen.getByRole('button',{name:'Update companion'})).toHaveProperty('disabled',true);
  view.rerender(<CompanionInstallPanel sessionId="second" ready onInstalled={vi.fn()}/>);
  await act(async()=>{finish(checked);});
  expect(screen.queryByText(/can be updated/)).toBeNull();
  check.mockRejectedValue({kind:'companion_release_unavailable',message:'private'});
  fireEvent.click(screen.getByRole('button',{name:'Check for updates'}));await act(async()=>{});
  expect(screen.getByRole('alert').textContent).toBe('The current release has no compatible companion available.');
  check.mockResolvedValue({...checked,latest:'x'});
  fireEvent.click(screen.getByRole('button',{name:'Check for updates'}));await act(async()=>{});
  expect(screen.getByRole('alert').textContent).toBe('Invalid companion installation response.');
});
it.each([['pt-BR','Verificar atualizações','Voltar para 1.50.0'],['es','Buscar actualizaciones','Volver a 1.50.0']])('shows check and rollback in %s',async(language,label,back)=>{
  await uiI18n.changeLanguage(language);check.mockResolvedValue(checked);
  render(<CompanionInstallPanel sessionId={`check-${language}`} onInstalled={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:label}));await act(async()=>{});
  expect(screen.getByRole('button',{name:back})).toBeTruthy();
});
