// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import ZellijPanel from './ZellijPanel';
import {accessSnapshot,applyAccessStatus} from './access';
import {t,uiI18n} from './i18n/core';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>true}));
beforeEach(()=>{authority();vi.mocked(invoke).mockResolvedValue(undefined);});
afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');vi.restoreAllMocks();vi.resetAllMocks();});
const sessionId='ssh:quick-tabs';
const name="build's <raw> {{name}}";
function authority(locked=false){applyAccessStatus({initialized:true,supported:true,enabled:true,locked,
  generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),reason:'Synthetic quick-tab authority',...(locked?{}:{nonce:'b'.repeat(64)})});}

it('maps all twenty explicit buttons to typed indices without changing manual drafts',async()=>{
  render(<ZellijPanel sessionId={sessionId} name={name} projectDirectory="/original/project"/>);
  fireEvent.change(screen.getByLabelText('New tab name'),{target:{value:'unsaved tab draft'}});
  fireEvent.change(screen.getByLabelText('Zellij project directory'),{target:{value:'/literal/unsaved directory'}});
  fireEvent.change(screen.getByLabelText('Tab number'),{target:{value:'42'}});
  expect(invoke).not.toHaveBeenCalled();
  for(const index of [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]){
    fireEvent.click(screen.getByRole('button',{name:`Tab ${index}`}));
    await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('zellij_action',{sessionId,name,action:{type:'goToTab',index}},{headers:{'X-Lazysh-Access':'b'.repeat(64)}}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Tab 20'})).toHaveProperty('disabled',false));
  }
  expect(invoke).toHaveBeenCalledTimes(20);
  expect((screen.getByLabelText('New tab name') as HTMLInputElement).value).toBe('unsaved tab draft');
  expect((screen.getByLabelText('Zellij project directory') as HTMLInputElement).value).toBe('/literal/unsaved directory');
  expect((screen.getByLabelText('Tab number') as HTMLInputElement).value).toBe('42');
});
it('holds one operation across locale changes and keeps raw missing-tab errors without retry',async()=>{
  let reject!:(reason:unknown)=>void;
  vi.mocked(invoke).mockImplementation(()=>new Promise((_,fail)=>{reject=fail;}));
  render(<ZellijPanel sessionId={sessionId} name={name}/>);
  const button=screen.getByRole('button',{name:'Tab 20'});
  fireEvent.click(button);fireEvent.click(button);
  expect(invoke).toHaveBeenCalledOnce();
  for(const locale of ['pt-BR','es','en']){
    await act(async()=>uiI18n.changeLanguage(locale));
    const group=screen.getByRole('group',{name:t('zellijQuickTabs')});
    expect(within(group).getAllByRole('button')).toHaveLength(20);
    expect(within(group).getByRole('button',{name:t('muxShortcutTab',{index:'20'})})).toBe(button);
    expect(button).toHaveProperty('disabled',true);
    expect(screen.getByRole('status').textContent).toBe(t('muxSending'));
    expect(invoke).toHaveBeenCalledOnce();
  }
  await act(async()=>reject("RAW missing tab <b> {{id}} 'quoted'"));
  expect(screen.getByRole('alert').textContent).toBe("RAW missing tab <b> {{id}} 'quoted'");
  expect(screen.getByRole('button',{name:'Tab 20'})).toHaveProperty('disabled',false);
  expect(invoke).toHaveBeenCalledOnce();
});
it.each(['unmount','access','session','name'] as const)('suppresses a late original-owner error after %s and never replays it',async boundary=>{
  let reject!:(reason:unknown)=>void;
  vi.mocked(invoke).mockImplementation(()=>new Promise((_,fail)=>{reject=fail;}));
  const view=render(<ZellijPanel sessionId={sessionId} name={name}/>);
  fireEvent.click(screen.getByRole('button',{name:'Tab 10'}));
  act(()=>{
    if(boundary==='unmount')view.unmount();
    else if(boundary==='access'){authority(true);authority();}
    else view.rerender(<ZellijPanel sessionId={boundary==='session'?'ssh-replacement':sessionId} name={boundary==='name'?'replacement':name}/>);
  });
  await act(async()=>reject('RAW stale host error'));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Action sent to Zellij.')).toBeNull();
  expect(invoke).toHaveBeenCalledOnce();
});
it('rejects new interaction after the mounted access or named-session context is retired',async()=>{
  const view=render(<ZellijPanel sessionId={sessionId} name={name}/>);
  act(()=>{authority(true);authority();});
  fireEvent.click(screen.getByRole('button',{name:'Tab 20'}));
  view.rerender(<ZellijPanel sessionId="ssh-replacement" name="new session"/>);
  fireEvent.click(screen.getByRole('button',{name:'Tab 10'}));
  expect(invoke).not.toHaveBeenCalled();
});
