// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
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
  // The receipt says Sending until the conversation holds the message, then Sent.
  expect(screen.getByText(t('agentReceiptSending'))).toBeTruthy();
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

it('requests a stop only on the second press, once',async()=>{
  mount();const stop=await screen.findByRole('button',{name:t('chatTerminalStop')});
  fireEvent.click(stop);
  expect(inputs()).toHaveLength(0);
  fireEvent.click(await screen.findByRole('button',{name:t('agentComposerStopConfirm')}));
  await waitFor(()=>expect(inputs()).toHaveLength(1));
  expect(inputs()[0]).toMatchObject({operation:1,input:{kind:'request_stop'}});
  expect(screen.queryByRole('button',{name:t('agentComposerStopConfirm')})).toBeNull();
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

async function bound(props:Partial<Parameters<typeof AgentComposer>[0]>={}) {
  const view=mount(props);await waitFor(()=>expect(actions().map(action=>action.kind)).toContain('bind'));
  await waitFor(()=>expect(screen.queryByText(t('chatTerminalPending'))).toBeNull());
  return view;
}
const props=()=>({sessionId:'ssh',conversation,access:captureAccess(),invoke:bindProtectedInvoke(captureAccess()),shown:true,labels:tmuxLabels,proof:{kind:'tmux' as const,paneId:'%3'},stage:true});

it('settles the receipt from the conversation: Sending, then Sent once the message appears, and an older identical prompt does not count',async()=>{
  const {view,access}=await bound({prompts:['Run it']});
  type('Run it');await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
  await waitFor(()=>expect(inputs()).toHaveLength(1));
  expect(screen.getByText(t('agentReceiptSending'))).toBeTruthy();
  const rerender=(prompts:string[])=>view.rerender(<AgentComposer {...props()} access={access} invoke={bindProtectedInvoke(access)} prompts={prompts}/>);
  rerender(['Run it']);expect(screen.queryByText(t('agentReceiptSent'))).toBeNull();
  rerender(['Run it','Run it']);expect(screen.getByText(t('agentReceiptSent'))).toBeTruthy();
});

it('stops claiming progress when the message never shows up',async()=>{
  await bound();type('Lost?');
  await waitFor(()=>expect(sendButton().disabled).toBe(false));
  fireEvent.click(sendButton());await waitFor(()=>expect(inputs()).toHaveLength(1));
  const start=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>start+9000);
  expect(await screen.findByText(t('agentReceiptUnconfirmed'),{},{timeout:3000})).toBeTruthy();
  expect(screen.queryByRole('button',{name:t('agentReceiptRetry')})).toBeNull();
});

it('shows Not sent with Retry when nothing was written, and Retry sends once; an uncertain delivery has no Retry',async()=>{
  await bound();
  vi.mocked(invoke).mockImplementation((command,args)=>(args as {action:{kind:string}}).action.kind==='input'?Promise.reject({kind:'tmux_chat_stale',message:'stale'}):tmuxChatReply(command,args));
  type('Important');await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
  expect(await screen.findByText(t('agentReceiptNotSent'))).toBeTruthy();
  vi.mocked(invoke).mockImplementation(tmuxChatReply);
  fireEvent.click(screen.getByRole('button',{name:t('agentReceiptRetry')}));
  await waitFor(()=>expect(inputs()).toHaveLength(2));
  expect((inputs()[1].input as {text:string}).text).toBe('Important');
  await waitFor(()=>expect(box().value).toBe(''));
  cleanup();
  await bound();
  vi.mocked(invoke).mockImplementation((command,args)=>(args as {action:{kind:string}}).action.kind==='input'?Promise.reject({message:'connection lost'}):tmuxChatReply(command,args));
  type('Maybe');await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
  expect(await screen.findByText(t('agentReceiptUncertain'))).toBeTruthy();
  expect(screen.queryByRole('button',{name:t('agentReceiptRetry')})).toBeNull();
});

it('recalls earlier prompts with Up and Down only from an empty or untouched recalled draft',async()=>{
  await bound();
  for(const text of ['first prompt','second prompt']) {
    type(text);await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
    await waitFor(()=>expect(box().value).toBe(''));
  }
  fireEvent.keyDown(box(),{key:'ArrowUp'});expect(box().value).toBe('second prompt');
  fireEvent.keyDown(box(),{key:'ArrowUp'});expect(box().value).toBe('first prompt');
  fireEvent.keyDown(box(),{key:'ArrowDown'});expect(box().value).toBe('second prompt');
  type('second prompt edited');fireEvent.keyDown(box(),{key:'ArrowUp'});expect(box().value).toBe('second prompt edited');
});

it('filters slash commands as you type, inserts the picked one without sending, and says when it opens a terminal dialog',async()=>{
  await bound();
  type('/mod');
  const list=screen.getByRole('listbox',{name:t('agentComposerCommands')});
  expect(within(list).getAllByRole('option').map(option=>option.textContent)).toEqual(['/model'+t('agentComposerOpensPicker')]);
  fireEvent.keyDown(box(),{key:'Enter'});
  expect(box().value).toBe('/model ');
  expect(inputs()).toHaveLength(0);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByText(t('agentComposerPickerNote',{command:'/model'}))).toBeTruthy();
  fireEvent.keyDown(box(),{key:'Enter'});
  await waitFor(()=>expect(inputs()).toHaveLength(1));
  expect((inputs()[0].input as {text:string}).text).toBe('/model ');
});

it('walks the palette with the arrows, closes it with Escape and picks with a tap',async()=>{
  await bound();
  type('/co');
  fireEvent.keyDown(box(),{key:'ArrowDown'});
  expect(screen.getAllByRole('option').filter(option=>option.getAttribute('aria-selected')==='true').map(option=>option.textContent)).toEqual(['/context']);
  fireEvent.keyDown(box(),{key:'Escape'});expect(screen.queryByRole('listbox')).toBeNull();
  type('/com');fireEvent.click(within(screen.getByRole('listbox')).getByRole('button',{name:/\/compact/}));
  expect(box().value).toBe('/compact ');
});

it('names the prompt mode a leading ! or # selects and sends the text byte-exact',async()=>{
  await bound();
  type('!ls -la');expect(screen.getByText(t('agentModeBash'))).toBeTruthy();
  await waitFor(()=>expect(sendButton().disabled).toBe(false));fireEvent.click(sendButton());
  await waitFor(()=>expect(inputs()).toHaveLength(1));
  expect((inputs()[0].input as {text:string}).text).toBe('!ls -la');
  type('#remember me');expect(screen.getByText(t('agentModeMemory'))).toBeTruthy();
  type('plain');expect(screen.queryByText(t('agentModeMemory'))).toBeNull();
});
