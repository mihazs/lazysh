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
it.each([['gemini','/home/user/.gemini'],['cursor','/home/user/.cursor']] as const)('uses the explicit %s profile only after inspection',async(agent,placeholder)=>{
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
