// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import ChatPanel from './ChatPanel';
import {t} from './i18n/core';
import {accessSnapshot,applyAccessStatus} from './access';
import {tmuxChatReply,tmuxChatReceipt,tmuxChatSource} from './test/tmuxChat';
import {confirmChatTerminal as confirmed} from './test/confirmChatTerminal';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
const page={schemaVersion:1,agent:'claude',messages:[],nextOffset:10,hasMore:false};
const capability={hostLabel:'Actual connected host label',terminalLabel:'Attached tmux terminal'};
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
it('does not clear an edited-away-and-back draft when a prior Send acknowledgement arrives',async()=>{
  await opened();await confirmed();let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>command==='tmux_chat' && (args as {action:{kind:string}}).action.kind==='input'?new Promise(yes=>{finish=yes;}):command==='tmux_chat'?tmuxChatReply(command,args):Promise.resolve(page));
  const draft=screen.getByLabelText('Draft for this terminal');fireEvent.change(draft,{target:{value:'original'}});
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));await waitFor(()=>expect(finish).toBeTypeOf('function'));
  fireEvent.change(draft,{target:{value:'new edit'}});fireEvent.change(draft,{target:{value:'original'}});
  await act(async()=>{finish({kind:'delivered',nextOperation:2});});await screen.findByText(t('chatTerminalSent'));
  expect(draft).toHaveProperty('value','original');expect(actions().filter(action=>action.kind==='input')).toHaveLength(1);
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
it.each(['claude','codex'] as const)('leaves manual %s composers without a native tmux eligibility/source match unchanged',async agent=>{
  vi.mocked(invoke).mockImplementation((command,args)=>command==='tmux_chat'?tmuxChatReply(command,args):Promise.resolve({...page,agent}));
  render(<ChatPanel sessionId="ssh-manual" terminalInput={agent==='codex'?capability:undefined}/>);
  if(agent==='codex')fireEvent.change(screen.getByLabelText('Agent'),{target:{value:agent}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/manual.jsonl'}});fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));
  await screen.findByRole('button',{name:t('chatRefreshMessages')});expect(screen.queryByRole('button',{name:t('chatTerminalChoose')})).toBeNull();expect(actions()).toEqual([]);
});
