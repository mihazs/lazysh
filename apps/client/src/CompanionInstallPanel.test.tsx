// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
const install=vi.hoisted(()=>vi.fn());
vi.mock('./bridge',()=>({api:{installCompanion:install}}));
import CompanionInstallPanel,{companionInstallStage,parseCompanionInstall} from './CompanionInstallPanel';
import {applyAccessStatus} from './access';
import {uiI18n} from './i18n/core';
const result={schemaVersion:1,status:'installed',version:'1.0.0',path:'/owned/lazysh-agent',cleanup:'complete'};
let generation=0;
beforeEach(async()=>{install.mockReset();await uiI18n.changeLanguage('en');applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++generation),nonce:'a'.repeat(64)});});
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
  const requests:{progress:(value:unknown)=>void;finish:(value:unknown)=>void}[]=[];
  install.mockImplementation((_source:string,progress:(value:unknown)=>void)=>new Promise(finish=>requests.push({progress,finish})));
  return requests;
}
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
