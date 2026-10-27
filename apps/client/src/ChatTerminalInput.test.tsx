// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {applyAccessStatus,bindProtectedInvoke,captureAccess} from './access';
import {t,uiI18n} from './i18n/core';
import ChatTerminalInput,{parseTerminalBinding,parseTerminalDelivered,parseTerminalSnapshot,validClaudeTerminalSource,validTerminalDraft} from './ChatTerminalInput';

import {confirmChatTerminal as confirm} from './test/confirmChatTerminal';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
import {tmuxChatSource as source,tmuxChatTarget as target,tmuxChatReceipt as receipt,tmuxChatSnapshot as snapshot,tmuxChatBound as bound,tmuxChatReply as nativeReply} from './test/tmuxChat';
let generation=0;
function access(locked=false) {
  applyAccessStatus({initialized:true,supported:true,enabled:true,reason:'',locked,generation:String(++generation),...(locked?{}:{nonce:'a'.repeat(64)})});
}
function actions(){return vi.mocked(invoke).mock.calls.map(([,args])=>(args as {action:Record<string,unknown>}).action);}
beforeEach(()=>{generation+=10;access();vi.mocked(invoke).mockReset().mockImplementation(nativeReply);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function fixture(overrides:Partial<ComponentProps<typeof ChatTerminalInput>>={}) {
  const lease=captureAccess(),sent=vi.fn();
  const props:ComponentProps<typeof ChatTerminalInput>={sessionId:'ssh-display',source,labels:{hostLabel:'Connected host',terminalLabel:'Agent terminal'},access:lease,invoke:bindProtectedInvoke(lease),draft:'  你好 😀  ',draftRevision:7,composing:{current:false},compositionActive:false,onSent:sent,...overrides};
  return {props,sent,view:render(<ChatTerminalInput {...props}/>)};
}
it('requires explicit snapshot and confirmation, displays only human destination labels, and sequences literal Send/Stop',async()=>{
  const {sent}=fixture();expect(invoke).not.toHaveBeenCalled();await confirm();
  expect(screen.getByText('Agent terminal')).toBeTruthy();expect(screen.getByText('Agent work')).toBeTruthy();expect(screen.getByText('Claude workspace')).toBeTruthy();
  for(const opaque of [target.generation,target.sessionId,target.windowId,target.paneId,receipt])expect(screen.queryByText(opaque)).toBeNull();
  expect(actions()).toEqual([{kind:'snapshot'},{kind:'bind',destination:target,source}]);
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByText(t('chatTerminalSent'));
  expect(actions()[2]).toEqual({kind:'input',receipt,source,operation:1,input:{kind:'send',text:'  你好 😀  '}});
  expect(sent).toHaveBeenCalledExactlyOnceWith('  你好 😀  ',7);
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalStop')}));await screen.findByText(t('chatTerminalStopRequested'));
  expect(actions()[3]).toEqual({kind:'input',receipt,source,operation:2,input:{kind:'request_stop'}});
  expect(sent).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith('tmux_chat',expect.anything(),{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
});
it('does not duplicate or automatically retry an uncertain input and retains draft authority only on exact acknowledgement',async()=>{
  const {sent}=fixture();await confirm();let fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>((args as {action:{kind:string}}).action.kind==='input')?new Promise((_yes,no)=>{fail=no;}):nativeReply(command,args));
  const send=screen.getByRole('button',{name:t('chatTerminalSend')});fireEvent.click(send);fireEvent.click(send);
  await waitFor(()=>expect(actions().filter(action=>action.kind==='input')).toHaveLength(1));
  await act(async()=>{fail({message:'Raw lost acknowledgement'});});
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Raw lost acknowledgement');expect(screen.getByText(t('chatTerminalUncertain'))).toBeTruthy();
  expect(screen.queryByRole('button',{name:t('chatTerminalSend')})).toBeNull();expect(sent).not.toHaveBeenCalled();
  expect(actions().filter(action=>action.kind==='input')).toHaveLength(1);expect(actions().at(-1)).toEqual({kind:'release',receipt});
});
it.each(['tmux_chat_invalid','tmux_chat_stale','tmux_chat_busy'])('retires UI authority after native %s without automatic rebind or resend',async kind=>{
  const {sent}=fixture();await confirm();
  vi.mocked(invoke).mockImplementation((command,args)=>((args as {action:{kind:string}}).action.kind==='input')?Promise.reject({kind,message:'Native detail'}):nativeReply(command,args));
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByRole('alert');
  expect(screen.queryByRole('button',{name:t('chatTerminalSend')})).toBeNull();expect(screen.queryByText(t('chatTerminalUncertain'))).toBeNull();
  expect(actions().filter(action=>action.kind==='bind')).toHaveLength(1);expect(actions().filter(action=>action.kind==='input')).toHaveLength(1);expect(sent).not.toHaveBeenCalled();
});
it('keeps old-companion and key-shaped raw errors literal with manual fallback',async()=>{
  vi.mocked(invoke).mockRejectedValueOnce({message:'old companion: tmux_chat unavailable'});fixture();
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','old companion: tmux_chat unavailable');
  expect(screen.getByText(t('chatTerminalFallback'))).toBeTruthy();expect(actions()).toEqual([{kind:'snapshot'}]);
});
it('rejects malformed/forged destination, receipt, source and operation shapes',()=>{
  for(const value of [null,{...snapshot,extra:true},{...snapshot,paneIndex:-1},{...snapshot,paneIndex:0x100000000},{...snapshot,sessionName:'x'.repeat(1025)},
    {...snapshot,destination:{...target,paneId:'%1\n'}},{...snapshot,destination:{...target,sessionId:['$1']}},{...snapshot,destination:{...target,generation:'NOT-A-UUID'}}])expect(()=>parseTerminalSnapshot(value)).toThrow();
  for(const value of [{...bound,receipt:'forged'},{...bound,nextOperation:2},{...bound,destination:{...target,paneId:'%4'}},{...bound,unexpected:0}])expect(()=>parseTerminalBinding(value,target)).toThrow();
  for(const nextOperation of [0,1,3,-1,0x100000000])expect(()=>parseTerminalDelivered({kind:'delivered',nextOperation},1)).toThrow();
  expect(parseTerminalDelivered({kind:'delivered',nextOperation:2},1)).toBe(2);
  for(const value of [{...source,agent:'codex'},{...source,view:'future'},{...source,path:'bad\npath'},{...source,transcriptSessionId:'invented'}])expect(validClaudeTerminalSource(value)).toBe(false);
});
it('rejects a malformed input acknowledgement as uncertain and never clears or resends the draft',async()=>{
  const {sent}=fixture();await confirm();vi.mocked(invoke).mockResolvedValueOnce({kind:'delivered',nextOperation:9});
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByRole('alert');
  expect(screen.getByText(t('chatTerminalUncertain'))).toBeTruthy();expect(sent).not.toHaveBeenCalled();expect(actions().filter(action=>action.kind==='input')).toHaveLength(1);
});
it('checks actual UTF-8 limits and malformed Unicode before TextEncoder replacement, preserving spaces',()=>{
  for(const value of ['  literal spaces  ','😀'.repeat(1024),'a'.repeat(4096)])expect(validTerminalDraft(value)).toBe(true);
  for(const value of ['',...['\n','\r','\t','\x00','\x7f','\x85','\u2028','\u2029'].map(control=>'a'+control+'b'),'😀'.repeat(1024)+'x','a'.repeat(4097)])expect(validTerminalDraft(value)).toBe(false);
  const encode=vi.spyOn(TextEncoder.prototype,'encode');
  for(const value of ['\ud800','\udfff','a\ud800z'])expect(validTerminalDraft(value)).toBe(false);
  expect(encode).not.toHaveBeenCalled();
});
it('does not dispatch Send or Stop while IME composition is active even before a rerender',async()=>{
  const {props}=fixture();await confirm();props.composing.current=true;
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));fireEvent.click(screen.getByRole('button',{name:t('chatTerminalStop')}));
  expect(actions().filter(action=>action.kind==='input')).toHaveLength(0);
});
const staleCases=(['snapshot','bind','input'] as const).flatMap(kind=>(['source','lease','unmount'] as const).flatMap(transition=>(['success','failure'] as const).map(outcome=>({kind,transition,outcome}))));
it.each(staleCases)('drops stale $kind $outcome after $transition while retiring future authority',async({kind,transition,outcome})=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>((args as {action:{kind:string}}).action.kind===kind)?new Promise((yes,no)=>{finish=yes;fail=no;}):nativeReply(command,args));
  const {props,sent,view}=fixture();
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));
  if(kind!=='snapshot')fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalConfirm')}));
  if(kind==='input')fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalSend')}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(transition==='source')view.rerender(<ChatTerminalInput {...props} source={{...source,path:'/different.jsonl'}}/>);
  else if(transition==='lease')await act(async()=>{access(true);access();});
  else view.unmount();
  await act(async()=>{if(outcome==='failure')fail({message:'obsolete native detail'});else finish(kind==='snapshot'?snapshot:kind==='bind'?bound:{kind:'delivered',nextOperation:2});});
  expect(sent).not.toHaveBeenCalled();expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText(t('chatTerminalSent'))).toBeNull();
  if(kind==='bind' && outcome==='success' && transition!=='lease')await waitFor(()=>expect(actions()).toContainEqual({kind:'release',receipt}));
  if(kind==='input')expect(actions().filter(action=>action.kind==='input')).toHaveLength(1); // Already admitted intent is not recalled by closing the view.
});
it.each(['en','pt-BR','es'])('translates destination actions and retained raw errors without IPC replay in %s',async locale=>{
  const {view}=fixture();await confirm();vi.mocked(invoke).mockRejectedValueOnce({message:'chatTerminalStale'});
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByRole('alert');const count=vi.mocked(invoke).mock.calls.length;
  try {await act(async()=>{await uiI18n.changeLanguage(locale);});expect(screen.getByRole('button',{name:t('chatTerminalChoose')})).toBeTruthy();expect(screen.getByRole('alert')).toHaveProperty('textContent','chatTerminalStale');expect(invoke).toHaveBeenCalledTimes(count);}
  finally {view.unmount();await act(async()=>{await uiI18n.changeLanguage('en');});}
});
it.each(['generation','receipt','sessionId','windowId','paneId'] as const)('rejects a trailing terminator in returned %s before it grants authority',field=>{
  for(const suffix of ['\n','\r\n','\u2028','\u2029']) {
    if(field==='receipt')expect(()=>parseTerminalBinding({...bound,receipt:receipt+suffix},target)).toThrow();
    else expect(()=>parseTerminalSnapshot({...snapshot,destination:{...target,[field]:target[field]+suffix}})).toThrow();
  }
});
it.each([{...bound,nextOperation:2},{...bound,destination:{...target,paneId:'%9'}},{...bound,extra:true}])('does not grant input from malformed bind output and releases the known candidate receipt',async reply=>{
  vi.mocked(invoke).mockImplementation((command,args)=>(args as {action:{kind:string}}).action.kind==='bind'?Promise.resolve(reply):nativeReply(command,args));fixture();
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalConfirm')}));
  await screen.findByRole('alert');expect(screen.queryByRole('button',{name:t('chatTerminalSend')})).toBeNull();
  expect(actions()).toContainEqual({kind:'release',receipt});expect(actions().filter(action=>action.kind==='input')).toHaveLength(0);
});
it.each([
  ['en','Text and Enter sent to the confirmed pane.','Escape sent to the confirmed pane. The process may still be running.'],
  ['pt-BR','Texto e Enter enviados ao painel confirmado.','Escape enviado ao painel confirmado. O processo pode continuar em execução.'],
  ['es','Texto y Enter enviados al panel confirmado.','Escape enviado al panel confirmado. El proceso puede seguir en ejecución.'],
])('limits acknowledgement copy to the confirmed pane and an unverified process in %s',async(locale,sent,stop)=>{
  try {
    await uiI18n.changeLanguage(locale);fixture();await confirm();fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByText(sent);
    fireEvent.click(screen.getByRole('button',{name:t('chatTerminalStop')}));await screen.findByText(stop);
  } finally {cleanup();await uiI18n.changeLanguage('en');}
});
