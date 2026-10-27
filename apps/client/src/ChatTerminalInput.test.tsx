// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {applyAccessStatus,bindProtectedInvoke,captureAccess} from './access';
import {transcriptAgents,type TranscriptAgentId} from './transcriptSources';
import {t,uiI18n} from './i18n/core';
import ChatTerminalInput,{parseTerminalBinding,parseTerminalDelivered,parseTerminalSnapshot,parseHerdrPrepared,validTerminalSource,validTerminalDraft} from './ChatTerminalInput';

import {herdrCandidate,herdrReceipt,herdrTarget,herdrPrepared,herdrBound,herdrChatReply} from './test/herdrChat';
import {confirmChatTerminal as confirm} from './test/confirmChatTerminal';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
import {tmuxChatSource as source,tmuxChatTarget as target,tmuxChatReceipt as receipt,tmuxChatSnapshot as snapshot,tmuxChatBound as bound,tmuxChatReply as nativeReply,tmuxChatReaderSource} from './test/tmuxChat';
let generation=0;
function access(locked=false) {
  applyAccessStatus({initialized:true,supported:true,enabled:true,reason:'',locked,generation:String(++generation),...(locked?{}:{nonce:'a'.repeat(64)})});
}
function actions(){return vi.mocked(invoke).mock.calls.map(([,args])=>(args as {action:Record<string,unknown>}).action);}
beforeEach(()=>{generation+=10;access();vi.mocked(invoke).mockReset().mockImplementation(nativeReply);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function fixture(overrides:Partial<ComponentProps<typeof ChatTerminalInput>>={}) {
  const lease=captureAccess(),sent=vi.fn();
  const props:ComponentProps<typeof ChatTerminalInput>={sessionId:'ssh-display',source,labels:{backend:'tmux' as const,hostLabel:'Connected host',terminalLabel:'Agent terminal'},access:lease,invoke:bindProtectedInvoke(lease),draft:'  你好 😀  ',draftRevision:7,composing:{current:false},compositionActive:false,onSent:sent,...overrides};
  return {props,sent,view:render(<ChatTerminalInput {...props}/>)};
}
it.each(['  你好 😀  ', '  first\n\té; \'"$()#{pane_id}\\ 世界\nlast  '])('requires confirmation and sequences exact Send/Stop bytes for %j',async draft=>{
  const {sent}=fixture({draft});expect(invoke).not.toHaveBeenCalled();expect(screen.getByText(t('chatTerminalPasteNote'))).toBeTruthy();await confirm();
  expect(screen.getByText('Agent terminal')).toBeTruthy();expect(screen.getByText('Agent work')).toBeTruthy();expect(screen.getByText('Claude workspace')).toBeTruthy();
  for(const opaque of [target.generation,target.sessionId,target.windowId,target.paneId,receipt])expect(screen.queryByText(opaque)).toBeNull();
  expect(actions()).toEqual([{kind:'snapshot'},{kind:'bind',destination:target,source}]);
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByText(t('chatTerminalSent'));
  expect(actions()[2]).toEqual({kind:'input',receipt,source,operation:1,input:{kind:'send',text:draft}});
  expect(sent).toHaveBeenCalledExactlyOnceWith(draft,7);
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalStop')}));await screen.findByText(t('chatTerminalStopRequested'));
  expect(actions()[3]).toEqual({kind:'input',receipt,source,operation:2,input:{kind:'request_stop'}});
  expect(sent).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith('tmux_chat',expect.anything(),{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
});
it.each(['one line','first\n\tsecond'])('retains draft and never retries uncertain input for %j',async draft=>{
  const {sent}=fixture({draft});await confirm();let fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>((args as {action:{kind:string}}).action.kind==='input')?new Promise((_yes,no)=>{fail=no;}):nativeReply(command,args));
  const send=screen.getByRole('button',{name:t('chatTerminalSend')});fireEvent.click(send);fireEvent.click(send);
  await waitFor(()=>expect(actions().filter(action=>action.kind==='input')).toHaveLength(1));
  await act(async()=>{fail({message:'Raw lost acknowledgement'});});
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Raw lost acknowledgement');expect(screen.getByText(t(draft.includes('\n')?'chatTerminalPasteUncertain':'chatTerminalUncertain'))).toBeTruthy();
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
  for(const value of [{...source,agent:'gemini'},{...source,view:'future'},{...source,path:'bad\npath'},{...source,transcriptSessionId:'invented'}])expect(validTerminalSource(value)).toBe(false);
});
it('rejects a malformed input acknowledgement as uncertain and never clears or resends the draft',async()=>{
  const {sent}=fixture();await confirm();vi.mocked(invoke).mockResolvedValueOnce({kind:'delivered',nextOperation:9});
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByRole('alert');
  expect(screen.getByText(t('chatTerminalUncertain'))).toBeTruthy();expect(sent).not.toHaveBeenCalled();expect(actions().filter(action=>action.kind==='input')).toHaveLength(1);
});
it('checks actual UTF-8 limits and malformed Unicode before TextEncoder replacement, preserving spaces',()=>{
  for(const value of ['  literal spaces  ','first\n\tsecond','\n'.repeat(4096),'😀'.repeat(1024),'a'.repeat(4096)])expect(validTerminalDraft(value)).toBe(true);
  for(const value of ['',...['\r','\x00','\x08','\x0b','\x1b','\x7f','\x85','\u2028','\u2029'].map(control=>'a'+control+'b'),'😀'.repeat(1024)+'x','a'.repeat(4097)])expect(validTerminalDraft(value)).toBe(false);
  const encode=vi.spyOn(TextEncoder.prototype,'encode');
  for(const value of ['\ud800','\udfff','a\ud800z'])expect(validTerminalDraft(value)).toBe(false);
  expect(encode).not.toHaveBeenCalled();
});
it.each(['one line','first\nsecond'])('does not dispatch during IME composition for %j',async draft=>{
  const {props}=fixture({draft});await confirm();props.composing.current=true;
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));fireEvent.click(screen.getByRole('button',{name:t('chatTerminalStop')}));
  expect(actions().filter(action=>action.kind==='input')).toHaveLength(0);
});
const staleCases=(['snapshot','bind','input'] as const).flatMap(kind=>(['source','session','lease','unmount'] as const).flatMap(transition=>(['success','failure'] as const).flatMap(outcome=>(kind==='input'?['one line','first\n\tsecond']:['one line']).map(draft=>({kind,transition,outcome,draft})))));
it.each(staleCases)('drops stale $kind $outcome after $transition for $draft',async({kind,transition,outcome,draft})=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>((args as {action:{kind:string}}).action.kind===kind)?new Promise((yes,no)=>{finish=yes;fail=no;}):nativeReply(command,args));
  const {props,sent,view}=fixture({draft});
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));
  if(kind!=='snapshot')fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalConfirm')}));
  if(kind==='input')fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalSend')}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(transition==='source')view.rerender(<ChatTerminalInput {...props} source={{...source,path:'/different.jsonl'}}/>);
  else if(transition==='session')view.rerender(<ChatTerminalInput {...props} sessionId="ssh-replacement"/>);
  else if(transition==='lease')await act(async()=>{access(true);access();});
  else view.unmount();
  await act(async()=>{if(outcome==='failure')fail({message:'obsolete native detail'});else finish(kind==='snapshot'?snapshot:kind==='bind'?bound:{kind:'delivered',nextOperation:2});});
  expect(sent).not.toHaveBeenCalled();expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText(t('chatTerminalSent'))).toBeNull();
  if(kind==='bind' && outcome==='success' && transition!=='lease')await waitFor(()=>expect(actions()).toContainEqual({kind:'release',receipt}));
  if(kind==='input')expect(actions().filter(action=>action.kind==='input')).toHaveLength(1); // Already admitted intent is not recalled by closing the view.
});
it.each(['en','pt-BR','es'])('translates destination actions and retained raw errors without IPC replay in %s',async locale=>{
  const {view}=fixture({draft:'first\n\tsecond'});await confirm();vi.mocked(invoke).mockRejectedValueOnce({message:'chatTerminalStale'});
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByRole('alert');const count=vi.mocked(invoke).mock.calls.length;
  try {await act(async()=>{await uiI18n.changeLanguage(locale);});expect(screen.getByRole('button',{name:t('chatTerminalChoose')})).toBeTruthy();expect(screen.getByRole('alert')).toHaveProperty('textContent','chatTerminalStale');expect(screen.getByText(t('chatTerminalPasteNote'))).toBeTruthy();expect(screen.getByText(t('chatTerminalPasteUncertain'))).toBeTruthy();expect(invoke).toHaveBeenCalledTimes(count);}
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

it.each(Object.keys(transcriptAgents))('admits explicit Records context for the supported %s adapter',agent=>{
  const value={...source,agent,...(['hermes','opencode'].includes(agent)?{transcriptSessionId:'literal-session'}:{})};
  expect(validTerminalSource(value)).toBe(true);
});

it.each(Object.keys(transcriptAgents) as TranscriptAgentId[])('enforces the native-reader option matrix for %s',agent=>{
  for(const view of ['records','conversation'])for(const inlineImages of [false,true]){
    const context={...tmuxChatReaderSource(agent),view,inlineImages};
    const expected=(view==='records'||['claude','grok-acp'].includes(agent)) && (!inlineImages||agent==='claude'||(view==='records'&&['codex','grok-acp'].includes(agent)));
    expect(validTerminalSource(context)).toBe(expected);
  }
});
it('rejects unknown agents and extra selector fields, retaining strict UTF-8 database selectors',()=>{
  for(const agent of ['gemini','qwen','future','constructor','__proto__','qoder_ide'])expect(validTerminalSource({...source,agent})).toBe(false);
  for(const transcriptSessionId of [null,undefined,'','invented'])expect(validTerminalSource({...source,transcriptSessionId})).toBe(false);
  for(const agent of ['hermes','opencode'] as const){
    expect(validTerminalSource({...source,agent})).toBe(false);
    for(const transcriptSessionId of [null,undefined,'','😀'.repeat(65),'a'.repeat(257),'id\n','id\u0085','\ud800'])expect(validTerminalSource({...source,agent,transcriptSessionId})).toBe(false);
    for(const transcriptSessionId of ['  literal $t(id) 界  ','😀'.repeat(64),'a'.repeat(256)])expect(validTerminalSource({...source,agent,transcriptSessionId})).toBe(true);
  }
});

const herdrLabels={backend:'herdr' as const,hostLabel:'Original host',terminalLabel:'Original Herdr display'};
function herdrFixture(overrides:Partial<ComponentProps<typeof ChatTerminalInput>>={}) {
  vi.mocked(invoke).mockImplementation(herdrChatReply);
  return fixture({labels:herdrLabels,...overrides});
}
it('requires explicit guarded Herdr preparation and confirmation on the original child session',async()=>{
  const {sent}=herdrFixture({source:tmuxChatReaderSource('hermes','original-db-session'),draft:'- first\n\t世界'});
  expect(invoke).not.toHaveBeenCalled();expect(screen.queryByText(t('chatTerminalPasteNote'))).toBeNull();await confirm();
  expect(actions()).toEqual([{kind:'status'},{kind:'prepare',source:tmuxChatReaderSource('hermes','original-db-session')},{kind:'confirm',candidate:herdrCandidate,source:tmuxChatReaderSource('hermes','original-db-session')}]);
  for(const value of [herdrTarget.workspace,herdrTarget.tab,herdrTarget.pane,herdrTarget.terminal])expect(screen.getByText(value)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByText(t('chatHerdrSent'));
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalStop')}));await screen.findByText(t('chatHerdrStopRequested'));
  expect(actions().slice(3)).toEqual([{kind:'input',receipt:herdrReceipt,source:tmuxChatReaderSource('hermes','original-db-session'),operation:1,input:{kind:'send',text:'- first\n\t世界'}},{kind:'input',receipt:herdrReceipt,source:tmuxChatReaderSource('hermes','original-db-session'),operation:2,input:{kind:'request_stop'}}]);
  expect(sent).toHaveBeenCalledExactlyOnceWith('- first\n\t世界',7);
  expect(vi.mocked(invoke).mock.calls.every(([command,args])=>command==='herdr_chat' && (args as {sessionId:string}).sessionId==='ssh-display')).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith('herdr_chat',expect.anything(),{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
});
it('releases an unconfirmed candidate on Cancel and never auto prepares again',async()=>{
  herdrFixture();fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalCancel')}));
  expect(actions()).toEqual([{kind:'status'},{kind:'prepare',source},{kind:'release',receipt:herdrCandidate}]);
  expect(screen.queryByRole('button',{name:t('chatTerminalSend')})).toBeNull();
});
it('keeps stock Herdr unavailable with Stage fallback and no preparation',async()=>{
  herdrFixture();vi.mocked(invoke).mockResolvedValueOnce({kind:'status',available:false});
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));expect(await screen.findByRole('alert')).toHaveProperty('textContent',t('chatHerdrUnavailable'));
  expect(actions()).toEqual([{kind:'status'}]);
});
it('validates exact public Herdr destinations without losing u64 precision',()=>{
  expect(parseHerdrPrepared(herdrPrepared).destination.runtimeGeneration).toBe('18446744073709551615');
  for(const generation of ['0','01','18446744073709551616','1\n',1])expect(()=>parseHerdrPrepared({...herdrPrepared,destination:{...herdrTarget,runtimeGeneration:generation}})).toThrow();
  for(const destination of [{...herdrTarget,ownership:'never-display'},{...herdrTarget,workspace:'x'.repeat(129)},{...herdrTarget,pane:'bad\n'},{...herdrTarget,viewport:{...herdrTarget.viewport,width:0}},{...herdrTarget,viewport:{...herdrTarget.viewport,x:65536}}])expect(()=>parseHerdrPrepared({...herdrPrepared,destination})).toThrow();
  expect(parseTerminalBinding({...herdrBound,destination:{...herdrTarget,viewport:{height:24,width:80,y:1,x:0}}},herdrTarget).receipt).toBe(herdrReceipt);
  expect(()=>parseTerminalBinding({...herdrBound,destination:{...herdrTarget,terminal:'other'}},herdrTarget)).toThrow();
});
const herdrStaleCases=(['status','prepare','confirm','input'] as const).flatMap(stage=>(['session','source','backend','lease','unmount'] as const).flatMap(change=>(['success','failure'] as const).map(outcome=>({stage,change,outcome}))));
it.each(herdrStaleCases)('retires Herdr $stage $outcome after $change without replay',async({stage,change,outcome})=>{
  const {props,sent,view}=herdrFixture();let finish!:(value:unknown)=>void,reject!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>(args as {action:{kind:string}}).action.kind===stage?new Promise((yes,no)=>{finish=yes;reject=no;}):herdrChatReply(command,args));
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));
  if(stage==='confirm'||stage==='input')fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalConfirm')}));
  if(stage==='input')fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalSend')}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(change==='session')view.rerender(<ChatTerminalInput {...props} sessionId="replacement"/>);
  else if(change==='source')view.rerender(<ChatTerminalInput {...props} source={{...source,path:'/replacement.jsonl'}}/>);
  else if(change==='backend')view.rerender(<ChatTerminalInput {...props} labels={{...herdrLabels,backend:'tmux'}}/>);
  else if(change==='lease')await act(async()=>{access(true);access();});
  else view.unmount();
  await act(async()=>{if(outcome==='failure')reject({message:'obsolete detail'});else finish(stage==='status'?{kind:'status',available:true}:stage==='prepare'?herdrPrepared:stage==='confirm'?herdrBound:{kind:'delivered',nextOperation:2});});
  expect(sent).not.toHaveBeenCalled();expect(screen.queryByRole('alert')).toBeNull();
  if(stage==='status')expect(actions().filter(action=>action.kind==='prepare')).toHaveLength(0);
  if(outcome==='success' && ['prepare','confirm'].includes(stage) && change!=='lease')expect(actions()).toContainEqual({kind:'release',receipt:stage==='prepare'?herdrCandidate:herdrReceipt});
  expect(actions().filter(action=>action.kind==='input')).toHaveLength(stage==='input'?1:0);
});
it.each(['en','pt-BR','es'])('keeps Herdr confirmation and raw target labels through %s locale changes',async locale=>{
  const {view}=herdrFixture();await confirm();const count=vi.mocked(invoke).mock.calls.length;
  try {await act(async()=>{await uiI18n.changeLanguage(locale);});expect(screen.getByText(herdrTarget.tab)).toBeTruthy();expect(screen.getByRole('button',{name:t('chatTerminalSend')})).toBeTruthy();expect(invoke).toHaveBeenCalledTimes(count);}
  finally {view.unmount();await act(async()=>{await uiI18n.changeLanguage('en');});}
});
