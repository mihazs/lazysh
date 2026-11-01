// @vitest-environment jsdom
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {render,screen,fireEvent,act,cleanup} from '@testing-library/react';
import {applyAccessStatus} from './access';
import {uiI18n} from './i18n/core';
const hooks=vi.hoisted(()=>vi.fn());
vi.mock('./bridge',()=>({api:{companionHooks:hooks}}));
import CompanionHooksPanel,{parseHookStatus} from './CompanionHooksPanel';
const inspected={schemaVersion:1,supported:true,state:null,installPlan:'a'.repeat(64),removePlan:'b'.repeat(64),reporting:'notChecked',trust:'notChecked'};
let epoch=1000;
beforeEach(async()=>{hooks.mockReset();await uiI18n.changeLanguage('en');applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++epoch),nonce:'d'.repeat(64)});});
afterEach(cleanup);
function selectProfile(){fireEvent.change(screen.getByLabelText('Host profile directory'),{target:{value:'/owned/profile'}});}
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
  expect(document.activeElement).toBe(screen.getByLabelText('Hook provider'));
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


it.each([
  ['codex','Open /hooks in Codex and review the lazysh hooks, then start a new turn. Existing disabled hooks stay disabled.'],
  ['claude','Open /hooks in Claude Code to inspect loaded hooks, then start a new turn. Existing hook restrictions still apply.'],
  ['opencode','Plugins load when the OpenCode server starts with this profile. Start a new turn to verify reporting.'],
] as const)('guides configured %s reporting without executing provider commands',async(agent,guide)=>{
  hooks.mockResolvedValue({...inspected,state:'configured'});
  render(<CompanionHooksPanel sessionId="owned-guide" visible/>);
  fireEvent.change(screen.getByLabelText('Hook provider'),{target:{value:agent}});selectProfile();
  expect(screen.queryByText(guide)).toBeNull();expect(hooks).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));
  expect(await screen.findByText(guide)).toBeTruthy();
  expect(screen.getByText('Hooks configured. Live reporting has not been verified.')).toBeTruthy();
  expect(hooks.mock.calls).toEqual([['owned-guide',{agent,action:'status',profileRoot:'/owned/profile'}]]);
  fireEvent.change(screen.getByLabelText('Host profile directory'),{target:{value:'/owned/other-profile'}});
  expect(screen.queryByText(guide)).toBeNull();expect(hooks).toHaveBeenCalledTimes(1);
});

it('retains generic trust guidance for other configured providers',async()=>{
  hooks.mockResolvedValue({...inspected,state:'configured'});
  render(<CompanionHooksPanel sessionId="owned-fallback" visible/>);
  fireEvent.change(screen.getByLabelText('Hook provider'),{target:{value:'gemini'}});selectProfile();
  fireEvent.click(screen.getByRole('button',{name:'Inspect setup'}));
  await screen.findByText('Hooks configured. Live reporting has not been verified.');
  expect(screen.getByText('Review provider trust settings and start a new agent session to verify reporting. Codex trust is never accepted automatically.')).toBeTruthy();
  expect(hooks).toHaveBeenCalledTimes(1);
});
