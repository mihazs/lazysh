// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import ChatPanel from './ChatPanel';
import {transcriptAgents,type TranscriptAgentId} from './transcriptSources';
import {t} from './i18n/core';
import {accessSnapshot,applyAccessStatus} from './access';
import {tmuxChatReply,tmuxChatReceipt,tmuxChatSource,tmuxChatReaderSource,tmuxChatReaderPage,tmuxChatTarget} from './test/tmuxChat';
import {confirmChatTerminal as confirmed} from './test/confirmChatTerminal';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
const page={schemaVersion:1,agent:'claude',messages:[],nextOffset:10,hasMore:false};
const capability={backend:'tmux' as const,hostLabel:'Actual connected host label',terminalLabel:'Attached tmux terminal'};
function actions(){return vi.mocked(invoke).mock.calls.filter(([command])=>command==='tmux_chat').map(([,args])=>(args as {action:Record<string,unknown>}).action);}
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(BigInt(accessSnapshot().status?.generation ?? '0')+1n),nonce:'a'.repeat(64)});
  vi.mocked(invoke).mockReset().mockImplementation((command,args)=>command==='tmux_chat'?tmuxChatReply(command,args):Promise.resolve(page));
});
afterEach(cleanup);
async function opened() {
  const view=render(<ChatPanel sessionId="ssh-display" terminalInput={capability}/>);
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:tmuxChatSource.path}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));
  await screen.findByRole('button',{name:t('chatTerminalChoose')});return view;
}
it('keeps Stage/form/CtrlEnter defaults and performs no destination IPC until the separate Choose/Confirm actions',async()=>{
  await opened();expect(actions()).toEqual([]);
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
  try {
    const draft=screen.getByLabelText('Draft for this terminal');fireEvent.change(draft,{target:{value:'literal unsent draft'}});
    fireEvent.keyDown(draft,{key:'Enter',ctrlKey:true});expect(staged).toHaveBeenCalledTimes(1);expect(actions()).toEqual([]);
    await confirmed();fireEvent.click(screen.getByRole('button',{name:'Stage in terminal'}));expect(staged).toHaveBeenCalledTimes(2);
    expect(actions().map(action=>action.kind)).toEqual(['snapshot','bind']);
    fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByText(t('chatTerminalSent'));
    expect(draft).toHaveProperty('value','');expect(actions().at(-1)).toEqual({kind:'input',receipt:tmuxChatReceipt,source:tmuxChatSource,operation:1,input:{kind:'send',text:'literal unsent draft'}});
  } finally {window.removeEventListener('lazysh-prompt-draft',staged);}
});
it('enables finished IME input after a same-value composition end without dispatching during composition',async()=>{
  await opened();await confirmed();const draft=screen.getByLabelText('Draft for this terminal');
  fireEvent.compositionStart(draft);fireEvent.change(draft,{target:{value:'完成'}});
  expect(screen.getByRole('button',{name:t('chatTerminalSend')})).toHaveProperty('disabled',true);
  fireEvent.compositionEnd(draft,{data:'完成'});
  expect(actions().filter(action=>action.kind==='input')).toHaveLength(0);
  expect(screen.getByRole('button',{name:t('chatTerminalSend')})).toHaveProperty('disabled',false);
  expect(screen.getByRole('button',{name:t('chatTerminalStop')})).toHaveProperty('disabled',false);
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByText(t('chatTerminalSent'));
});
it.each(['original','first\n\tsecond'])('preserves edited-away-and-back draft after delayed acknowledgement for %j',async text=>{
  await opened();await confirmed();let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>command==='tmux_chat' && (args as {action:{kind:string}}).action.kind==='input'?new Promise(yes=>{finish=yes;}):command==='tmux_chat'?tmuxChatReply(command,args):Promise.resolve(page));
  const draft=screen.getByLabelText('Draft for this terminal');fireEvent.change(draft,{target:{value:text}});
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await waitFor(()=>expect(finish).toBeTypeOf('function'));
  fireEvent.change(draft,{target:{value:'new edit'}});fireEvent.change(draft,{target:{value:text}});
  await act(async()=>{finish({kind:'delivered',nextOperation:2});});await screen.findByText(t('chatTerminalSent'));
  expect(draft).toHaveProperty('value',text);expect(actions().filter(action=>action.kind==='input')).toHaveLength(1);
});
it('retires on explicit Open starting, including a failed replacement, without changing continuation refresh authority',async()=>{
  await opened();await confirmed();expect(actions().filter(action=>action.kind==='bind')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:t('chatRefreshMessages')}));await waitFor(()=>expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='agent_transcript')).toHaveLength(2));
  expect(screen.getByRole('button',{name:t('chatTerminalStop')})).toBeTruthy();expect(actions().filter(action=>action.kind==='release')).toHaveLength(0);
  let fail!:(error:unknown)=>void;vi.mocked(invoke).mockImplementation((command,args)=>command==='agent_transcript'?new Promise((_yes,no)=>{fail=no;}):tmuxChatReply(command,args));
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await waitFor(()=>expect(fail).toBeTypeOf('function'));
  expect(screen.queryByRole('button',{name:t('chatTerminalChoose')})).toBeNull();
  expect(actions()).toContainEqual({kind:'release',receipt:tmuxChatReceipt});
  await act(async()=>{fail({message:'Explicit replacement read failed'});});await screen.findByRole('button',{name:t('chatTerminalChoose')});
  expect(screen.queryByRole('button',{name:t('chatTerminalStop')})).toBeNull();expect(actions().filter(action=>action.kind==='bind')).toHaveLength(1);
});
it('source option changes retire future authority, while a previously admitted Send may still complete',async()=>{
  await opened();await confirmed();let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>command==='tmux_chat' && (args as {action:{kind:string}}).action.kind==='input'?new Promise(yes=>{finish=yes;}):command==='tmux_chat'?tmuxChatReply(command,args):Promise.resolve(page));
  const draft=screen.getByLabelText('Draft for this terminal');fireEvent.change(draft,{target:{value:'already submitted intent'}});fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));fireEvent.click(screen.getByLabelText('Include recorded images'));
  expect(actions()).toContainEqual({kind:'release',receipt:tmuxChatReceipt});
  await act(async()=>{finish({kind:'delivered',nextOperation:2});});
  expect(draft).toHaveProperty('value','already submitted intent');expect(screen.queryByText(t('chatTerminalSent'))).toBeNull();expect(actions().filter(action=>action.kind==='input')).toHaveLength(1);
});
async function openedReader(agent:TranscriptAgentId,selector='database-session',eligible=true){
  const source=tmuxChatReaderSource(agent,selector);vi.mocked(invoke).mockImplementation((command,args)=>command==='tmux_chat'?tmuxChatReply(command,args):Promise.resolve(tmuxChatReaderPage(agent)));
  const view=render(<ChatPanel sessionId="all-reader-display" terminalInput={eligible?capability:undefined}/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:agent}});fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:source.path}});
  if('transcriptSessionId' in source)fireEvent.change(screen.getByLabelText('Transcript session ID'),{target:{value:source.transcriptSessionId}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByRole('button',{name:t('chatRefreshMessages')});
  return {...view,source};
}
it.each(Object.keys(transcriptAgents) as TranscriptAgentId[])('offers explicit terminal confirmation for a successfully read %s source without passive destination IPC',async agent=>{
  const {source}=await openedReader(agent);expect(screen.getByRole('button',{name:t('chatTerminalChoose')})).toBeTruthy();expect(actions()).toEqual([]);
  await confirmed();expect(actions().find(action=>action.kind==='bind')).toEqual({kind:'bind',destination:expect.anything(),source});
  fireEvent.change(screen.getByLabelText('Draft for this terminal'),{target:{value:'same literal 界'}});fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await screen.findByText(t('chatTerminalSent'));
  expect(actions().filter(action=>action.kind==='input')).toEqual([{kind:'input',receipt:tmuxChatReceipt,source,operation:1,input:{kind:'send',text:'same literal 界'}}]);
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalStop')}));await screen.findByText(t('chatTerminalStopRequested'));
  expect(actions().filter(action=>action.kind==='input').at(-1)).toEqual({kind:'input',receipt:tmuxChatReceipt,source,operation:2,input:{kind:'request_stop'}});
});
it.each(['hermes','opencode'] as const)('retires %s selector authority on same-path edits and requires a new confirmation after A→B→A',async agent=>{
  await openedReader(agent,'session-A');await confirmed();const selector=screen.getByLabelText('Transcript session ID');
  fireEvent.change(selector,{target:{value:'session-B'}});expect(screen.queryByRole('button',{name:t('chatTerminalChoose')})).toBeNull();
  expect(actions()).toContainEqual({kind:'release',receipt:tmuxChatReceipt});fireEvent.change(selector,{target:{value:'session-A'}});
  expect(screen.getByRole('button',{name:t('chatTerminalChoose')})).toBeTruthy();expect(screen.queryByRole('button',{name:t('chatTerminalSend')})).toBeNull();expect(actions().filter(action=>action.kind==='bind')).toHaveLength(1);
});
it.each((['hermes','opencode'] as const).flatMap(agent=>(['bind','input'] as const).map(kind=>({agent,kind}))))('drops a held $agent $kind completion after selector A→B→A without rebind or draft loss',async({agent,kind})=>{
  await openedReader(agent,'session-A');let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>command==='tmux_chat'&&(args as {action:{kind:string}}).action.kind===kind?new Promise(resolve=>{finish=resolve;}):tmuxChatReply(command,args));
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalConfirm')}));
  const draft=screen.getByLabelText('Draft for this terminal');fireEvent.change(draft,{target:{value:'retained 界 draft'}});
  if(kind==='input')fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalSend')}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));const selector=screen.getByLabelText('Transcript session ID');
  fireEvent.change(selector,{target:{value:'session-B'}});fireEvent.change(selector,{target:{value:'session-A'}});
  await act(async()=>finish(kind==='bind'?{kind:'bound',receipt:tmuxChatReceipt,destination:tmuxChatTarget,nextOperation:1}:{kind:'delivered',nextOperation:2}));
  expect(draft).toHaveProperty('value','retained 界 draft');expect(screen.queryByText(t('chatTerminalSent'))).toBeNull();expect(screen.queryByRole('button',{name:t('chatTerminalSend')})).toBeNull();
  expect(actions().filter(action=>action.kind==='bind')).toHaveLength(1);expect(actions()).toContainEqual({kind:'release',receipt:tmuxChatReceipt});
});
it.each(['claude','codex','hermes'] as const)('keeps %s Stage-only when native tmux capability is absent',async agent=>{
  await openedReader(agent,'session-A',false);expect(screen.queryByRole('button',{name:t('chatTerminalChoose')})).toBeNull();expect(actions()).toEqual([]);
});
