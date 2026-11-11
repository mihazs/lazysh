// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import AgentComposer from './AgentComposer';
import {bindProtectedInvoke,captureAccess} from './access';
import {chatFollowAccess} from './test/chatFollowAccess';
import {t} from './i18n/core';
import {tmuxChatBound,tmuxChatReceipt,tmuxChatReply,tmuxChatSnapshot,tmuxChatTarget} from './test/tmuxChat';
import {herdrChatReply,herdrTarget} from './test/herdrChat';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

const conversation={agent:'claude' as const,path:'/home/owner/.claude/projects/work/a.jsonl',report:{sessionId:'s1',agent:'Claude Code',paneId:'%3'}};
const tmuxLabels={backend:'tmux' as const,hostLabel:'host',terminalLabel:'work'};
const actions=()=>vi.mocked(invoke).mock.calls.map(([,args])=>(args as {action:{kind:string;input?:unknown;operation?:number}}).action);
const inputs=()=>actions().filter(action=>action.kind==='input');
function mount(props:Partial<Parameters<typeof AgentComposer>[0]>={}) {
  const access=captureAccess();
  const view=render(<AgentComposer sessionId="ssh" conversation={conversation} access={access} invoke={bindProtectedInvoke(access)} shown labels={tmuxLabels} proof={{kind:'tmux',paneId:'%3'}} stage {...props}/>);
  return {view,access};
}
const box=()=>screen.getByRole('textbox',{name:t('chatDraftLabel')}) as HTMLTextAreaElement;
const type=(value:string)=>fireEvent.change(box(),{target:{value}});
const sendButton=()=>screen.getByRole('button',{name:t('agentComposerSend')}) as HTMLButtonElement;
beforeEach(()=>{chatFollowAccess();vi.mocked(invoke).mockReset().mockImplementation(tmuxChatReply);window.matchMedia=vi.fn(()=>({matches:false})) as never;});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

it('binds to the proven pane without a confirmation step and delivers a message once, then clears the draft',async()=>{
  mount();await waitFor(()=>expect(actions().map(action=>action.kind)).toEqual(['snapshot','bind']));
  expect(screen.queryByRole('button',{name:t('chatTerminalChoose')})).toBeNull();expect(screen.queryByRole('button',{name:t('chatTerminalConfirm')})).toBeNull();
  type('Add a test\nfor the parser');
  await waitFor(()=>expect(sendButton().disabled).toBe(false));
  fireEvent.click(sendButton());
  await waitFor(()=>expect(box().value).toBe(''));
  expect(inputs()).toEqual([{kind:'input',receipt:tmuxChatReceipt,source:{agent:'claude',path:conversation.path,view:'conversation',inlineImages:false},operation:1,input:{kind:'send',text:'Add a test\nfor the parser'}}]);
  expect(screen.getByText(t('chatTerminalSent'))).toBeTruthy();
});

it('sends with Enter on a hardware keyboard, keeps Shift+Enter as a new line and ignores Enter while composing text',async()=>{
  mount();await waitFor(()=>expect(actions().map(action=>action.kind)).toContain('bind'));await waitFor(()=>expect(screen.queryByText(t('chatTerminalPending'))).toBeNull());
  type('第一');fireEvent.compositionStart(box());fireEvent.keyDown(box(),{key:'Enter'});
  fireEvent.keyDown(box(),{key:'Enter',shiftKey:true});
  expect(inputs()).toHaveLength(0);
  fireEvent.compositionEnd(box());
  fireEvent.keyDown(box(),{key:'Enter',shiftKey:true});expect(inputs()).toHaveLength(0);
  fireEvent.keyDown(box(),{key:'Enter'});
  await waitFor(()=>expect(inputs()).toHaveLength(1));
  expect((inputs()[0].input as {text:string}).text).toBe('第一');
});

it('keeps Enter as a new line on a touch keyboard and sends with the button',async()=>{
  window.matchMedia=vi.fn(()=>({matches:true})) as never;
  mount();await waitFor(()=>expect(actions().map(action=>action.kind)).toContain('bind'));
  type('line one');fireEvent.keyDown(box(),{key:'Enter'});expect(inputs()).toHaveLength(0);
  await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
  await waitFor(()=>expect(inputs()).toHaveLength(1));
});

it('requests a stop through the guarded input',async()=>{
  mount();const stop=await screen.findByRole('button',{name:t('chatTerminalStop')});
  fireEvent.click(stop);await waitFor(()=>expect(inputs()).toHaveLength(1));
  expect(inputs()[0]).toMatchObject({operation:1,input:{kind:'request_stop'}});
});

it('refuses to send when the pane the agent runs in is not the terminal, and offers Stage with the reason',async()=>{
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged as EventListener);
  mount({proof:{kind:'tmux',paneId:'%9'}});
  expect(await screen.findByText(t('agentComposerWrongPane'))).toBeTruthy();
  expect(actions().map(action=>action.kind)).toEqual(['snapshot']);
  type('hello');fireEvent.click(await screen.findByRole('button',{name:t('chatStage')}));
  expect(inputs()).toHaveLength(0);expect(staged).toHaveBeenCalledTimes(1);
  expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'ssh',text:'hello'});
  window.removeEventListener('lazysh-prompt-draft',staged as EventListener);
});

it('keeps the explicit destination confirmation for a conversation no evidence ties to this terminal',async()=>{
  mount({proof:undefined,stage:false});
  expect(actions()).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));
  fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalConfirm')}));
  await screen.findByRole('button',{name:t('chatTerminalSend')});
  expect(actions().map(action=>action.kind)).toEqual(['snapshot','bind']);
  type('typed by hand');fireEvent.click(screen.getByRole('button',{name:t('chatTerminalSend')}));
  await waitFor(()=>expect(inputs()).toHaveLength(1));
});

it('stages a draft when the session takes no confirmed input',async()=>{
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged as EventListener);
  mount({labels:undefined,proof:undefined});
  expect(screen.getByText(t('agentViewStageOnly'))).toBeTruthy();
  type('stage me');fireEvent.keyDown(box(),{key:'Enter'});
  expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'ssh',text:'stage me'});
  expect(screen.getByText(t('chatDraftStaged'))).toBeTruthy();expect(invoke).not.toHaveBeenCalled();
  window.removeEventListener('lazysh-prompt-draft',staged as EventListener);
});

it('renders nothing for a conversation that can neither take input nor be staged',()=>{
  const {view}=mount({labels:undefined,proof:undefined,stage:false});expect(view.container.textContent).toBe('');
});

it('keeps an unsent draft for its conversation across the view being closed and opened again',async()=>{
  const first=mount();type('keep me');first.view.unmount();
  mount();expect(box().value).toBe('keep me');
  cleanup();mount({conversation:{...conversation,path:'/other.jsonl',report:{sessionId:'s2',agent:'Claude Code',paneId:'%3'}}});expect(box().value).toBe('');
});

it('retains the draft and offers a reconnect, without resending, when delivery fails',async()=>{
  mount();await waitFor(()=>expect(actions().map(action=>action.kind)).toContain('bind'));
  vi.mocked(invoke).mockImplementation((command,args)=>(args as {action:{kind:string}}).action.kind==='input'?Promise.reject({kind:'tmux_chat_stale',message:'stale'}):tmuxChatReply(command,args));
  type('important');await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
  await screen.findByRole('alert');expect(box().value).toBe('important');
  expect(inputs()).toHaveLength(1);
  vi.mocked(invoke).mockImplementation(tmuxChatReply);
  fireEvent.click(await screen.findByRole('button',{name:t('agentComposerReconnect')}));
  await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
  await waitFor(()=>expect(box().value).toBe(''));expect(inputs()).toHaveLength(2);
});

it('binds a guarded Herdr terminal only when it is the pane of the proven agent',async()=>{
  vi.mocked(invoke).mockImplementation(herdrChatReply);
  const herdr={kind:'herdr' as const,pane:herdrTarget.pane,terminal:herdrTarget.terminal};
  const {view,access}=mount({labels:{backend:'herdr',hostLabel:'host',terminalLabel:'work'},proof:herdr});
  await waitFor(()=>expect(actions().map(action=>action.kind)).toEqual(['status','prepare','confirm']));
  type('to herdr');await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
  await waitFor(()=>expect(inputs()).toHaveLength(1));
  view.unmount();vi.mocked(invoke).mockClear();
  render(<AgentComposer sessionId="ssh" conversation={conversation} access={access} invoke={bindProtectedInvoke(access)} shown labels={{backend:'herdr',hostLabel:'host',terminalLabel:'work'}} proof={{...herdr,pane:'other'}} stage/>);
  expect(await screen.findByText(t('agentComposerWrongPane'))).toBeTruthy();
  expect(actions().map(action=>action.kind)).toEqual(['status','prepare']);
});

it('does not hold a binding while the view is hidden',async()=>{
  const {view,access}=mount({shown:false});
  expect(invoke).not.toHaveBeenCalled();
  view.rerender(<AgentComposer sessionId="ssh" conversation={conversation} access={access} invoke={bindProtectedInvoke(access)} shown labels={tmuxLabels} proof={{kind:'tmux',paneId:tmuxChatTarget.paneId}} stage/>);
  await waitFor(()=>expect(actions().map(action=>action.kind)).toEqual(['snapshot','bind']));
  expect(tmuxChatSnapshot.destination.paneId).toBe('%3');expect(tmuxChatBound.nextOperation).toBe(1);
  await act(async()=>{view.rerender(<AgentComposer sessionId="ssh" conversation={conversation} access={access} invoke={bindProtectedInvoke(access)} shown={false} labels={tmuxLabels} proof={{kind:'tmux',paneId:'%3'}} stage/>);});
  expect(actions().at(-1)).toEqual({kind:'release',receipt:tmuxChatReceipt});
});
