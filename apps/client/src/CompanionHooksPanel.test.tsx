// @vitest-environment jsdom
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {render,screen,fireEvent,act,cleanup} from '@testing-library/react';
import {applyAccessStatus} from './access';
import {uiI18n} from './i18n/core';
const {hooks,discover}=vi.hoisted(()=>({hooks:vi.fn(),discover:vi.fn()}));
vi.mock('./bridge',()=>({api:{companionHooks:hooks,companionHookDiscovery:discover}}));
import CompanionHooksPanel,{parseHookStatus,parseHookDiscovery} from './CompanionHooksPanel';
const inspected={schemaVersion:1,supported:true,state:null,installPlan:'a'.repeat(64),removePlan:'b'.repeat(64),reporting:'notChecked',trust:'notChecked'};
let epoch=1000;
beforeEach(async()=>{hooks.mockReset();discover.mockReset().mockResolvedValue({schemaVersion:1,supported:true,managedSetupSupported:true,agents:[],truncated:false});await uiI18n.changeLanguage('en');applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++epoch),nonce:'d'.repeat(64)});});
afterEach(cleanup);
function selectProfile(){fireEvent.change(screen.getByLabelText('Hook provider'),{target:{value:'codex'}});fireEvent.change(screen.getByLabelText('Host profile directory'),{target:{value:'/owned/profile'}});}
it('refuses unsafe plans and treats conflicts and unsupported filesystems as non-writable',()=>{
  expect(parseHookStatus(inspected).installPlan).toBe(inspected.installPlan);
  for(const patch of [{schemaVersion:2},{installPlan:'foreign'},{trust:'trusted'},{reporting:'verified'},{state:'other'}])expect(()=>parseHookStatus({...inspected,...patch})).toThrow();
  expect(parseHookStatus({...inspected,state:'conflict'}).installPlan).toBeUndefined();
  expect(parseHookStatus({schemaVersion:1,supported:false,reason:'HooksAclUnsupported',reporting:'notChecked',trust:'notChecked'}).supported).toBe(false);
});
it('requires inspection and a separate explicit install before refreshing reporting-neutral status',async()=>{
  hooks.mockResolvedValueOnce(inspected).mockResolvedValueOnce({schemaVersion:1,outcome:{status:'configured'},reporting:'notChecked',trust:'notChecked'}).mockResolvedValueOnce({...inspected,state:'configured'});
  render(<CompanionHooksPanel sessionId="owned-ssh" visible/>);selectProfile();
  expect(hooks).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'Install or update hooks'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));
  fireEvent.click(await screen.findByRole('button',{name:'Install or update hooks'}));
  expect(await screen.findByText('Hooks configured. Live reporting has not been verified.')).toBeTruthy();
  expect(hooks.mock.calls[1]).toEqual(['owned-ssh',{agent:'codex',action:'install',profileRoot:'/owned/profile',expectedPlan:inspected.installPlan}]);
  expect(hooks).toHaveBeenCalledTimes(3);
});
it('retires old selections and never restores stale install plans on a new connection',async()=>{
  let finish!:(value:unknown)=>void;hooks.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<CompanionHooksPanel sessionId="old" visible/>);selectProfile();fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));
  view.rerender(<CompanionHooksPanel sessionId="new" visible/>);
  await act(async()=>{finish(inspected);});
  expect(screen.queryByRole('button',{name:'Install or update hooks'})).toBeNull();expect(hooks).toHaveBeenCalledTimes(1);
});
it('requires a fresh inspection after an uncertain write without retrying it',async()=>{
  hooks.mockResolvedValueOnce(inspected).mockResolvedValueOnce({schemaVersion:1,outcome:{status:'uncertain'},reporting:'notChecked',trust:'notChecked'});
  render(<CompanionHooksPanel sessionId="uncertain" visible/>);selectProfile();fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));fireEvent.click(await screen.findByRole('button',{name:'Install or update hooks'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Setup could not be confirmed. Inspect again before retrying.');
  expect(screen.queryByRole('button',{name:'Install or update hooks'})).toBeNull();expect(hooks).toHaveBeenCalledTimes(2);
});
it.each([['gemini','/home/user/.gemini'],['cursor','/home/user/.cursor'],['droid','/home/user/.factory']] as const)('uses the explicit %s profile only after inspection',async(agent,placeholder)=>{
  hooks.mockResolvedValueOnce(inspected).mockResolvedValueOnce({schemaVersion:1,outcome:{status:'configured'},reporting:'notChecked',trust:'notChecked'}).mockResolvedValueOnce({...inspected,state:'configured'});
  render(<CompanionHooksPanel sessionId="new-provider" visible/>);
  fireEvent.change(screen.getByLabelText('Hook provider'),{target:{value:agent}});
  expect(screen.getByLabelText('Host profile directory')).toHaveProperty('placeholder',placeholder);
  expect(hooks).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Host profile directory'),{target:{value:`/owned/${agent} profile`}});
  fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));
  fireEvent.click(await screen.findByRole('button',{name:'Install or update hooks'}));
  await screen.findByText('Hooks configured. Live reporting has not been verified.');
  expect(hooks.mock.calls[1]).toEqual(['new-provider',{agent,action:'install',profileRoot:`/owned/${agent} profile`,expectedPlan:inspected.installPlan}]);
});

it('explains required native Droid standalone setup without enabling mutation',async()=>{
  hooks.mockResolvedValue({schemaVersion:1,supported:false,reason:'HooksDroidStandaloneRequired',reporting:'notChecked',trust:'notChecked'});
  render(<CompanionHooksPanel sessionId="droid-fallback" visible/>);selectProfile();fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));
  expect(await screen.findByText('Create standalone hooks.json in Droid’s /hooks UI, then inspect again. Existing settings and legacy hooks are not migrated.')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Install or update hooks'})).toBeNull();expect(hooks).toHaveBeenCalledTimes(1);
});

it('reveals the exact hook workflow once without inspecting or installing and preserves its drafts',()=>{
  const request={sessionId:'owned-hook-setup'};
  const view=render(<CompanionHooksPanel sessionId="owned-hook-setup" visible reveal={request}/>);
  const disclosure=view.container.querySelector('details')!;
  expect(disclosure.open).toBe(true);
  expect(document.activeElement).toBe(disclosure.querySelector('summary'));
  selectProfile();expect(hooks).not.toHaveBeenCalled();
  fireEvent.click(disclosure.querySelector('summary')!);expect(disclosure.open).toBe(false);
  view.rerender(<CompanionHooksPanel sessionId="owned-hook-setup" visible={false} reveal={request}/>);
  view.rerender(<CompanionHooksPanel sessionId="owned-hook-setup" visible reveal={request}/>);
  expect(disclosure.open).toBe(false);expect(screen.getByLabelText('Host profile directory')).toHaveProperty('value','/owned/profile');
  view.rerender(<CompanionHooksPanel sessionId="owned-hook-setup" visible reveal={{sessionId:'owned-hook-setup'}}/>);
  expect(disclosure.open).toBe(true);expect(hooks).not.toHaveBeenCalled();
});

it.each(['hidden','other-source','revoked'])('drops a %s reveal request without replaying it later',state=>{
  if(state==='revoked')applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(++epoch)});
  const request={sessionId:state==='other-source'?'old-source':'owned-hook-setup'};
  const view=render(<CompanionHooksPanel sessionId="owned-hook-setup" visible={state!=='hidden'} reveal={request}/>);
  const disclosure=view.container.querySelector('details')!;
  expect(disclosure.open).toBe(false);expect(hooks).not.toHaveBeenCalled();
  if(state==='revoked')applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++epoch),nonce:'d'.repeat(64)});
  view.rerender(<CompanionHooksPanel sessionId={request.sessionId} visible reveal={request}/>);
  expect(disclosure.open).toBe(false);expect(hooks).not.toHaveBeenCalled();
});

const detected={schemaVersion:1,supported:true,managedSetupSupported:true,agents:[{agent:'codex',setup:'managed',executable:{path:'/owned/bin/codex',source:'path'},profiles:[{path:'/owned/custom profile',source:'CODEX_HOME',state:'directory'}]}],truncated:false};
function openDiscovery(container:HTMLElement){const details=container.querySelector('details')!;details.open=true;fireEvent(details,new Event('toggle'));return details;}
it('validates bounded discovery and refuses unknown providers, capabilities and private payload fields',()=>{
  expect(parseHookDiscovery(detected).agents[0].profiles[0].path).toBe('/owned/custom profile');
  for(const patch of [{schemaVersion:2},{privateConfig:'must not be accepted'},{supported:'yes'},{managedSetupSupported:'yes'},{truncated:1},{supported:false},{agents:Array(12).fill(detected.agents[0])},{agents:[detected.agents[0],detected.agents[0]]}])expect(()=>parseHookDiscovery({...detected,...patch})).toThrow();
  const original=detected.agents[0];
  for(const patch of [{agent:'unknown'},{setup:'manual'},{executable:{path:'/owned/codex',source:'other'}},{profiles:[{path:null,source:'default',state:'directory'}]},{profiles:[{path:'/owned/../foreign',source:'default',state:'directory'}]},{executable:{path:'relative/codex',source:'path'}},{privateContents:'refused'},{profiles:[{path:'/owned/profile',source:'default',state:'configured'}]},{profiles:[{path:'x'.repeat(4097),source:'default',state:'missing'}]},{profiles:[{path:'/owned/profile',source:'default\nprivate',state:'directory'}]},{profiles:Array(9).fill(original.profiles[0])}])expect(()=>parseHookDiscovery({...detected,agents:[{...original,...patch}]})).toThrow();
});
it('detects only opened visible setup and requires an explicit profile selection and inspected install',async()=>{
  discover.mockResolvedValue(detected);hooks.mockResolvedValueOnce(inspected).mockResolvedValueOnce({schemaVersion:1,outcome:{status:'configured'},reporting:'notChecked',trust:'notChecked'}).mockResolvedValueOnce({...inspected,state:'configured'});
  const view=render(<CompanionHooksPanel sessionId="discovered-host" visible/>);
  expect(discover).not.toHaveBeenCalled();expect(screen.getByLabelText('Hook provider')).toHaveProperty('value','');
  openDiscovery(view.container);
  const row=await screen.findByRole('button',{name:/Codex.*Installed executable/});
  expect(discover).toHaveBeenCalledExactlyOnceWith('discovered-host');expect(row.getAttribute('aria-pressed')).toBe('false');expect(hooks).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Inspect setup'})).toHaveProperty('disabled',true);
  fireEvent.click(row);expect(screen.getByLabelText('Host profile directory')).toHaveProperty('value','/owned/custom profile');expect(hooks).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));fireEvent.click(await screen.findByRole('button',{name:'Install or update hooks'}));
  await screen.findByText('Hooks configured. Live reporting has not been verified.');
  expect(hooks.mock.calls[1]).toEqual(['discovered-host',{agent:'codex',action:'install',profileRoot:'/owned/custom profile',expectedPlan:inspected.installPlan}]);
});
it('keeps installed executable, missing profile, manual setup and health-only capabilities separate',async()=>{
  discover.mockResolvedValue({...detected,truncated:true,agents:[{...detected.agents[0],profiles:[{path:'/missing',source:'CODEX_HOME',state:'missing'}]},{agent:'cline',setup:'manual',executable:{path:'/owned/bin/cline',source:'path'},profiles:[]},{agent:'aider',setup:'healthOnly',executable:{path:'/owned/bin/aider',source:'path'},profiles:[]}]});
  const view=render(<CompanionHooksPanel sessionId="capabilities" visible/>);openDiscovery(view.container);
  expect(await screen.findByRole('button',{name:/Codex.*Profile missing/})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:/Cline.*Manual setup/})).toHaveProperty('disabled',true);expect(screen.getByRole('button',{name:/Aider.*Callback health only/})).toHaveProperty('disabled',true);
  expect(screen.getByText('Some locations were not checked. Use a manual path if needed.')).toBeTruthy();expect(hooks).not.toHaveBeenCalled();
  selectProfile();expect(screen.getByRole('button',{name:'Inspect setup'})).toHaveProperty('disabled',false);
});
it.each(['hidden','source','closed','locked'])('drops late discovery on %s without selecting a profile',async(state)=>{
  let finish!:(value:unknown)=>void;discover.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<CompanionHooksPanel sessionId="old-discovery" visible/>);const details=openDiscovery(view.container);
  await act(async()=>{});const completeOld=finish;
  if(state==='hidden')view.rerender(<CompanionHooksPanel sessionId="old-discovery" visible={false}/>);
  if(state==='source')view.rerender(<CompanionHooksPanel sessionId="new-discovery" visible/>);
  if(state==='closed'){details.open=false;fireEvent(details,new Event('toggle'));}
  if(state==='locked')applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(++epoch)});
  await act(async()=>completeOld(detected));
  expect(screen.queryByRole('button',{name:/Codex.*Installed executable/})).toBeNull();expect(screen.getByLabelText('Hook provider')).toHaveProperty('value','');expect(hooks).not.toHaveBeenCalled();
});
it('retains manual inspection when discovery is unavailable, but disables managed setup when explicitly unsupported',async()=>{
  discover.mockRejectedValueOnce(new Error('Old companion'));
  const view=render(<CompanionHooksPanel sessionId="legacy" visible/>);openDiscovery(view.container);
  await screen.findByText('Detection unavailable. Update the companion or choose a profile manually.');selectProfile();expect(screen.getByRole('button',{name:'Inspect setup'})).toHaveProperty('disabled',false);
  discover.mockResolvedValue({...detected,managedSetupSupported:false});view.rerender(<CompanionHooksPanel sessionId="unsupported" visible/>);
  await screen.findByText('Managed hook setup is not supported on this host filesystem yet.');selectProfile();expect(screen.getByRole('button',{name:'Inspect setup'})).toHaveProperty('disabled',true);expect(hooks).not.toHaveBeenCalled();
});

it('retires inspected plans when another detected profile is explicitly selected',async()=>{
  discover.mockResolvedValue({...detected,agents:[{...detected.agents[0],profiles:[...detected.agents[0].profiles,{path:'/owned/second',source:'HOME',state:'directory'}]}]});
  hooks.mockResolvedValue(inspected);
  const view=render(<CompanionHooksPanel sessionId="profile-choice" visible/>);openDiscovery(view.container);
  fireEvent.click(await screen.findByRole('button',{name:/Codex.*custom profile/}));
  fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));await screen.findByRole('button',{name:'Install or update hooks'});
  fireEvent.click(screen.getByRole('button',{name:/Codex.*second/}));
  expect(screen.queryByRole('button',{name:'Install or update hooks'})).toBeNull();expect(hooks).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Host profile directory')).toHaveProperty('value','/owned/second');expect(document.activeElement).toBe(screen.getByRole('button',{name:'Inspect setup'}));
});
it('late discovery never overwrites an explicitly entered target or inspects it',async()=>{
  let finish!:(value:unknown)=>void;discover.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<CompanionHooksPanel sessionId="manual-during-discovery" visible/>);openDiscovery(view.container);
  fireEvent.change(screen.getByLabelText('Hook provider'),{target:{value:'gemini'}});fireEvent.change(screen.getByLabelText('Host profile directory'),{target:{value:'/owned/manual'}});
  await act(async()=>finish(detected));
  expect(screen.getByLabelText('Hook provider')).toHaveProperty('value','gemini');expect(screen.getByLabelText('Host profile directory')).toHaveProperty('value','/owned/manual');expect(hooks).not.toHaveBeenCalled();
});

it('unselects a pressed detected row and retires its inspected plan without hook actions',async()=>{
  discover.mockResolvedValue(detected);hooks.mockResolvedValue(inspected);
  const view=render(<CompanionHooksPanel sessionId="unselect-profile" visible/>);openDiscovery(view.container);
  const row=await screen.findByRole('button',{name:/Codex.*Installed executable/});
  fireEvent.click(row);expect(document.activeElement).toBe(screen.getByRole('button',{name:'Inspect setup'}));
  fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));await screen.findByRole('button',{name:'Install or update hooks'});
  expect(row.getAttribute('aria-pressed')).toBe('true');row.focus();fireEvent.click(row);
  expect(row.getAttribute('aria-pressed')).toBe('false');expect(document.activeElement).toBe(row);
  expect(screen.getByLabelText('Hook provider')).toHaveProperty('value','');expect(screen.getByLabelText('Host profile directory')).toHaveProperty('value','');
  expect(screen.getByRole('button',{name:'Inspect setup'})).toHaveProperty('disabled',true);expect(screen.queryByRole('button',{name:'Install or update hooks'})).toBeNull();
  expect(hooks).toHaveBeenCalledExactlyOnceWith('unselect-profile',{agent:'codex',action:'status',profileRoot:'/owned/custom profile'});
});
