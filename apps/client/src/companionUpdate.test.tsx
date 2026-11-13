// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {applyAccessStatus} from './access';
import {AgentPanel} from './AgentPanel';
import {companionUpdatedEvent,parseCompanionUpdate} from './companionUpdate';
import {t,uiI18n} from './i18n/core';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));

let generation=1000;
beforeEach(()=>{applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++generation),nonce:'a'.repeat(64)});});
afterEach(async()=>{cleanup();vi.clearAllMocks();await uiI18n.changeLanguage('en');});
const update=(state:string,reason?:string)=>({schemaVersion:1,sessions:[],update:{state,from:'1.55.0',to:'1.56.0',...(reason?{reason}:{})}});
/** The host answers each poll with the next reply. */
const board=(...replies:unknown[])=>{
  const queue=[...replies];
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_snapshot'?(queue.length>1?queue.shift():queue[0]):command==='agent_approvals'?{schemaVersion:1,requests:[]}:{schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true});
};

describe('what a snapshot says about the host companion updating itself',()=>{
  it('takes only a well-formed update and ignores anything else instead of failing the board',()=>{
    expect(parseCompanionUpdate(update('started'))).toEqual({state:'started',from:'1.55.0',to:'1.56.0'});
    expect(parseCompanionUpdate(update('failed','verificationFailed'))?.reason).toBe('verificationFailed');
    for(const bad of [null,{},{update:null},{update:{state:'installing',from:'1.55.0',to:'1.56.0'}},{update:{state:'done',from:'1.55',to:'1.56.0'}},{update:{state:'done',from:'1.55.0',to:'1.56.0-rc1'}},{update:{state:'failed',from:'1.55.0',to:'1.56.0',reason:'<img src=x>'}},{update:{state:'failed',from:'1.55.0',to:'1.56.0',reason:7}}])
      expect(parseCompanionUpdate(bad),JSON.stringify(bad)).toBeUndefined();
  });
  it('shows a quiet progress row while the host updates, then the new version, and tells open views once',async()=>{
    board(update('started'),update('running'),update('done'),update('done'));
    const heard=vi.fn();window.addEventListener(companionUpdatedEvent,heard);
    vi.useFakeTimers({shouldAdvanceTime:true});
    try {
      render(<AgentPanel sessionId="host-a"/>);
      expect((await screen.findByText('Updating the host companion to 1.56.0…')).getAttribute('data-update-state')).toBe('started');
      expect(heard).not.toHaveBeenCalled();
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(screen.getByText('Updating the host companion to 1.56.0…').getAttribute('data-update-state')).toBe('running');
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(screen.getByText('The host companion is now version 1.56.0.')).toBeTruthy();
      expect(heard).toHaveBeenCalledOnce();
      expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'host-a'});
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(heard).toHaveBeenCalledOnce();
    } finally {window.removeEventListener(companionUpdatedEvent,heard);vi.useRealTimers();}
  });
  it.each([
    ['failed',undefined,/could not be updated to 1\.56\.0\. It stays on 1\.55\.0\. Open Host companion installation/],
    ['failed','verificationFailed',/the download did not match release 1\.56\.0, so nothing was changed/],
    ['skipped','policyOff',/older than this app \(1\.56\.0\)\. Automatic updates are turned off on this host/],
    ['skipped','policyNotify',/Automatic updates are turned off on this host/],
    ['skipped','activeTurn',/will update to 1\.56\.0 when the agent finishes its turn/],
  ] as const)('says %s (%s) in one line',async(state,reason,text)=>{
    board(update(state,reason));render(<AgentPanel sessionId="host-a"/>);
    expect((await screen.findByText(text)).getAttribute('data-update-reason')).toBe(reason??null);
  });
  it.each([['skipped','networkUnavailable'],['skipped','busy'],['skipped','invalidAppVersion'],['skipped','rolledBack']] as const)('stays silent for %s %s, which the user can neither wait for nor fix',async(state,reason)=>{
    board(update(state,reason),update(state,reason));render(<AgentPanel sessionId="host-a"/>);
    await screen.findByText(t('agentsResultCount',{shown:'0',total:'0'}));
    expect(document.querySelector('.companion-update')).toBeNull();
  });
  it('shows nothing for a companion that sends no update, and speaks the interface language',async()=>{
    board({schemaVersion:1,sessions:[]});render(<AgentPanel sessionId="host-a"/>);
    await screen.findByText(t('agentsResultCount',{shown:'0',total:'0'}));
    expect(document.querySelector('.companion-update')).toBeNull();
    cleanup();
    for(const [locale,text] of [['pt-BR','Atualizando o companion do servidor para 1.56.0…'],['es','Actualizando el companion del servidor a 1.56.0…']] as const) {
      await act(async()=>{await uiI18n.changeLanguage(locale);});
      board(update('running'));render(<AgentPanel sessionId="host-a"/>);
      expect(await screen.findByText(text)).toBeTruthy();cleanup();
    }
  });
});
