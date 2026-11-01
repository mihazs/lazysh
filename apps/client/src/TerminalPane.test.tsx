// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import {uiI18n,useUi} from "./i18n/core";
import {LocalUiError,uiErrorText,type UiErrorCause} from "./i18n/localError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {prepareClipboardPlatform} from "./deviceClipboard";
import TerminalPane, { terminalWebUrl } from "./TerminalPane";
import { defaults, getPreferences, savePreferences } from "./preferences";
import type { LiveSession } from "./terminal";
import {accessSnapshot,applyAccessStatus} from './access';
const mocks = vi.hoisted(() => ({write: vi.fn(), writeSequence:vi.fn(), resize: vi.fn(), zellijNavigate: vi.fn(), openWebUrl: vi.fn(), clipboardIsAndroid:vi.fn(),clipboardRead:vi.fn(),clipboardCancel:vi.fn(), link: undefined as undefined | ((event: MouseEvent, uri: string) => void)}));
vi.mock("./bridge", () => ({api: mocks}));
vi.mock("@xterm/addon-fit", () => ({FitAddon: class {fit() {} dispose() {}}}));
vi.mock("@xterm/addon-web-links", () => ({WebLinksAddon: class {constructor(handler: typeof mocks.link) {mocks.link = handler;} dispose() {}}}));
let osc: (data: string) => boolean;
let terminal: ReturnType<typeof createMockTerminal>;
function createMockTerminal() {
  return {_core: {coreService: {onUserInput: (_listener:()=>void) => ({dispose() {}})}}, options: {}, modes:{mouseTrackingMode:'none'}, rows:24, hasSelection: vi.fn(() => false), loadAddon: vi.fn(), parser: {registerOscHandler: vi.fn((_code: number, handler: typeof osc) => {osc = handler; return {dispose() {}};})}, attachCustomKeyEventHandler: vi.fn(), open: vi.fn(), onData: (_callback: (data:string)=>void) => ({dispose() {}}), onResize: (_listener:(size:{cols:number;rows:number})=>void) => ({dispose() {}}), focus: vi.fn(), blur: vi.fn(), paste: vi.fn(), getSelection: () => "selected", buffer: {active: {length: 2, getLine: (index: number) => ({translateToString: () => ["hello", "world"][index]})}}, scrollToLine: vi.fn(), select: vi.fn()};
}
function access(locked=false) {
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'a'.repeat(64)})});
}
beforeEach(() => {
  access();
  vi.clearAllMocks();
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, options: MouseEventInit & {pointerId?: number; pointerType?: string} = {}) {super(type, options); this.pointerId = options.pointerId ?? 1; this.pointerType = options.pointerType ?? "touch";}
  });
  mocks.write.mockResolvedValue(undefined); mocks.writeSequence.mockResolvedValue(undefined); mocks.resize.mockResolvedValue(undefined);
  mocks.openWebUrl.mockResolvedValue(undefined);
  mocks.zellijNavigate.mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {callback(); return 1;});
  Object.defineProperty(navigator, "clipboard", {value: {writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue("paste me")}, configurable: true});
  savePreferences({...defaults});
  terminal = createMockTerminal();
});
afterEach(async () => {cleanup(); await uiI18n.changeLanguage("en"); vi.useRealTimers(); vi.unstubAllGlobals();});
function mount() {
  return render(<TerminalPane session={{id: "ssh", name: "Host", connected: true, terminal} as unknown as LiveSession} active reportError={vi.fn()} />);
}
it.each(['write','resize'] as const)('keeps structured native and localized %s failures readable',async operation=>{
  let receive!:(data:string)=>void, resized!:(size:{cols:number;rows:number})=>void;
  terminal.onData=listener=>{receive=listener;return{dispose(){}};};
  terminal.onResize=(listener:(size:{cols:number;rows:number})=>void)=>{resized=listener;return{dispose(){}};};
  const reportError=vi.fn();
  render(<TerminalPane session={{id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession} active reportError={reportError} />);
  for(const cause of [{kind:'transport_error',message:'Owned transport unavailable'},new LocalUiError('hostToolsClosed')]) {
    mocks[operation].mockRejectedValueOnce(cause);
    await act(async()=>{if(operation==='write')receive('reply');else resized({cols:80,rows:24});});
    expect(reportError).toHaveBeenLastCalledWith(cause instanceof LocalUiError?cause:cause.message);
  }
});
function mountInputOwner(initial = "") {
  const element=document.createElement('div'), textarea=document.createElement('textarea');
  textarea.value=initial;
  element.append(textarea); Object.assign(terminal,{element,textarea});
  let mark!:()=>void, receive!:(data:string)=>void;
  terminal._core.coreService.onUserInput=(listener:()=>void)=>{mark=listener;return{dispose(){}};};
  terminal.onData=listener=>{receive=listener;return{dispose(){}};};
  terminal.focus.mockImplementation(()=>textarea.focus());
  const session={id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession;
  const reportError=vi.fn();
  const view=render(<TerminalPane session={session} active reportError={reportError} />);
  const emit=(data:string,user=true)=>{if(user)mark();receive(data);};
  return {textarea,session,view,emit,reportError};
}
it.each(['terminal-user','terminal-nonuser','named-key','chord','gesture'] as const)('records content-free %s input failures without hiding the cause',async caller=>{
  const focused=vi.spyOn(document,'hasFocus').mockReturnValue(true);
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    savePreferences({...defaults,chords:[{label:'Owned sequence',keys:'C-b T'}],bodyGestures:{...defaults.bodyGestures,tap:'escape',doubleTap:'none',tripleTap:'none'}});
    const owner=mountInputOwner();
    const send=()=>{
      if(caller.startsWith('terminal-'))owner.emit('private-content-😀',caller==='terminal-user');
      else if(caller==='named-key')fireEvent.click(screen.getByRole('button',{name:'tab'}));
      else if(caller==='chord')fireEvent.click(screen.getByRole('button',{name:'Owned sequence'}));
      else {
        const canvas=screen.getByLabelText('Terminal for Host');
        fireEvent.pointerDown(canvas,{pointerId:1,pointerType:'touch',clientX:10,clientY:10});
        fireEvent.pointerUp(canvas,{pointerId:1,pointerType:'touch',clientX:10,clientY:10});
      }
    };
    for(const [kind,cause,message] of [['backpressure','queue-full','Terminal input queue is full'],['input_closed','channel-closed','Terminal input channel is closed'],['transport_error','other','private native failure']]) {
      mocks[caller==='chord'?'writeSequence':'write'].mockRejectedValueOnce({kind,message,hostId:'private-host',sessionId:'private-session'});
      await act(async()=>send());
      const raw=warn.mock.calls.at(-1)!;
      expect(raw).toHaveLength(1);
      const receipt=JSON.parse((raw[0] as string).replace('lazysh-terminal-input ',''));
      expect(receipt).toEqual({caller,cause,utf16Units:caller.startsWith('terminal-')?18:caller==='chord'?2:1,
        dispatch:{active:true,connected:true,disposed:false,currentOwner:true},receipt:{active:true,connected:true,disposed:false,currentOwner:true}});
      expect(raw[0]).not.toMatch(/private|ssh|Host|😀/);
      expect(owner.reportError).toHaveBeenLastCalledWith(message);
    }
  } finally {focused.mockRestore();warn.mockRestore();}
});
it.each(['inactive','disconnect','replacement','dispose'] as const)('captures dispatch and %s receipt ownership without retaining the rejected input',async boundary=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  let reject!:(error:unknown)=>void;
  mocks.write.mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
  try {
    const owner=mountInputOwner();
    act(()=>owner.emit('x'.repeat(70000),false));
    if(boundary==='dispose')owner.view.unmount();
    else owner.view.rerender(<TerminalPane session={boundary==='replacement'?{...owner.session,id:'private-replacement'}:boundary==='disconnect'?{...owner.session,connected:false}:owner.session} active={boundary!=='inactive'} reportError={owner.reportError} />);
    await act(async()=>reject({kind:'input_closed',message:'private failure'}));
    const receipt=JSON.parse((warn.mock.calls.at(-1)![0] as string).replace('lazysh-terminal-input ',''));
    expect(receipt).toEqual({caller:'terminal-nonuser',cause:'channel-closed',utf16Units:65536,
      dispatch:{active:true,connected:true,disposed:false,currentOwner:true},
      receipt:{active:boundary!=='inactive'&&boundary!=='dispose',connected:boundary!=='disconnect',disposed:boundary==='replacement'||boundary==='dispose',currentOwner:boundary!=='replacement'&&boundary!=='dispose'}});
    expect(owner.reportError).toHaveBeenLastCalledWith('private failure');
    expect(warn.mock.calls.at(-1)![0]).not.toContain('private');
  } finally {warn.mockRestore();}
});
function touchScrollFixture() {
  const target = document.createElement('div');
  Object.assign(terminal, {element: target});
  const wheels: WheelEvent[] = [];
  target.addEventListener('wheel', event => wheels.push(event));
  const view = mount();
  const canvas = screen.getByLabelText('Terminal for Host');
  const touch = (type: string, x: number, y: number) => canvas.dispatchEvent(new TouchEvent(type, {
    bubbles:true,cancelable:true,touches:type==='touchend'||type==='touchcancel'?[]:[{identifier:1,clientX:x,clientY:y}] as Touch[],
  }));
  return {view, canvas, wheels, touch, target};
}
describe("terminal interactions", () => {
  it.each(['hidden','inactive','disconnect','lock','dispose'] as const)('clears unapplied local context at the %s boundary',boundary=>{
    const windowFocus=vi.spyOn(document,'hasFocus').mockReturnValue(true);
    const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(false);
    try {
      Object.assign(terminal._core,{_compositionHelper:{_isComposing:false,_isSendingComposition:false,_compositionView:document.createElement('span')}});
      const owner=mountInputOwner('previous');
      const announcement=screen.getByRole('status');expect(announcement.textContent).toBe('');
      act(()=>{
        owner.textarea.value='local correction';owner.textarea.setSelectionRange(16,16);
        owner.textarea.dispatchEvent(new InputEvent('input',{data:'local correction',inputType:'insertReplacementText',bubbles:true}));
      });
      expect(screen.getByText('Edit not sent · Review')).toBeDefined();
      expect(announcement.textContent).toBe('Edit not sent');
      expect(document.activeElement).toBe(owner.textarea);
      expect(owner.textarea.readOnly).toBe(true);expect(mocks.write).not.toHaveBeenCalled();
      if(boundary==='hidden'){hidden.mockReturnValue(true);fireEvent(document,new Event('visibilitychange'));}
      else if(boundary==='lock')act(()=>access(true));
      else if(boundary==='dispose')owner.view.unmount();
      else owner.view.rerender(<TerminalPane session={boundary==='disconnect'?{...owner.session,connected:false}:owner.session} active={boundary!=='inactive'} reportError={vi.fn()} />);
      expect(screen.queryByText('Edit not sent · Review')).toBeNull();
      if(boundary==='dispose')expect(announcement.isConnected).toBe(false);
      else expect(announcement.textContent).toBe('');
      expect(owner.textarea.value).toBe('');expect(mocks.write).not.toHaveBeenCalled();
    } finally {windowFocus.mockRestore();hidden.mockRestore();}
  });
  it.each(['hidden','inactive','unfocused window','unfocused editor'] as const)('rejects user input for an %s context while preserving protocol replies',boundary=>{
    const windowFocus=vi.spyOn(document,'hasFocus').mockReturnValue(true);
    const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(false);
    try {
      const owner=mountInputOwner();
      owner.emit('foreground');expect(mocks.write).toHaveBeenLastCalledWith('ssh','foreground');mocks.write.mockClear();
      if(boundary==='hidden'){hidden.mockReturnValue(true);fireEvent(document,new Event('visibilitychange'));}
      else if(boundary==='inactive')owner.view.rerender(<TerminalPane session={owner.session} active={false} reportError={vi.fn()} />);
      else if(boundary==='unfocused window')windowFocus.mockReturnValue(false);
      else owner.textarea.blur();
      owner.emit('late IME commit');expect(mocks.write).not.toHaveBeenCalled();
      owner.emit('\x1b[1;1R',false);expect(mocks.write).toHaveBeenCalledExactlyOnceWith('ssh','\x1b[1;1R');
    } finally {windowFocus.mockRestore();hidden.mockRestore();}
  });
  it('preserves guarded composer paste with a focused composer instead of the terminal editor',()=>{
    const windowFocus=vi.spyOn(document,'hasFocus').mockReturnValue(true);
    try {
      const owner=mountInputOwner();terminal.paste.mockImplementation(text=>owner.emit(text));
      fireEvent.click(screen.getByRole('button',{name:'Compose'}));
      const composer=screen.getByLabelText('Compose text');fireEvent.change(composer,{target:{value:'owned draft'}});composer.focus();
      expect(document.activeElement).toBe(composer);
      fireEvent.click(screen.getByRole('button',{name:'Paste draft'}));
      expect(mocks.write).toHaveBeenCalledExactlyOnceWith('ssh','owned draft');
    } finally {windowFocus.mockRestore();}
  });

  it('offers a metadata-only retry, reports loading, and requires a new Paste gesture after readiness', async () => {
    vi.stubGlobal('isTauri', true);
    mocks.clipboardIsAndroid.mockRejectedValueOnce(new Error('private metadata failure'));
    const view = mount();
    fireEvent.click(screen.getByRole('button', {name:'Retry clipboard check'}));
    await waitFor(() => expect(screen.getByRole('button', {name:'Retry clipboard check'})).toHaveProperty('disabled',false));
    let finish!: (value:boolean)=>void;
    mocks.clipboardIsAndroid.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    fireEvent.click(screen.getByRole('button', {name:'Retry clipboard check'}));
    expect(screen.getByRole('button', {name:'Checking clipboard support…'})).toHaveProperty('disabled',true);
    expect(navigator.clipboard.readText).not.toHaveBeenCalled(); expect(mocks.clipboardRead).not.toHaveBeenCalled();
    await act(async()=>finish(false));
    expect(screen.getByRole('button', {name:'paste'})).toHaveProperty('disabled',false);
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name:'paste'}));
    expect(navigator.clipboard.readText).toHaveBeenCalledOnce();
    await waitFor(()=>expect(terminal.paste).toHaveBeenCalledExactlyOnceWith('paste me'));
    view.unmount();
  });
  it.each(['current', 'current failure', 'inactive then active', 'unmounted'] as const)('exposes owned native paste progress until its %s completion', async outcome => {
    vi.stubGlobal('isTauri', true);
    mocks.clipboardIsAndroid.mockResolvedValue(true); await prepareClipboardPlatform(); mocks.clipboardCancel.mockResolvedValue(undefined);
    let finish!: (value: unknown) => void;
    let reject!: (error: string) => void;
    mocks.clipboardRead.mockImplementation(() => new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
    const session = {id:'native-paste',name:'Host',connected:true,terminal} as unknown as LiveSession;
    const reportError = vi.fn();
    const view = render(<TerminalPane session={session} active reportError={reportError} />);
    const paste = screen.getByRole('button', {name:'paste'});
    fireEvent.click(paste);
    await waitFor(() => expect(mocks.clipboardRead).toHaveBeenCalledOnce());
    expect(paste).toHaveProperty('disabled', true); expect(paste.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(paste); expect(mocks.clipboardRead).toHaveBeenCalledOnce();
    if (outcome === 'inactive then active') {
      view.rerender(<TerminalPane session={session} active={false} reportError={reportError} />);
      view.rerender(<TerminalPane session={session} active reportError={reportError} />);
    } else if (outcome === 'unmounted') view.unmount();
    terminal.focus.mockClear();
    await act(async () => {
      if (outcome === 'current failure') reject('clipboard_unavailable');
      else finish({kind:'text',text:'literal $native clipboard'});
    });
    if (outcome === 'current') {
      expect(terminal.paste).toHaveBeenCalledExactlyOnceWith('literal $native clipboard');
      expect(terminal.focus).toHaveBeenCalledOnce(); expect(mocks.clipboardCancel).not.toHaveBeenCalled();
    } else if (outcome === 'current failure') {
      expect(terminal.paste).not.toHaveBeenCalled(); expect(terminal.focus).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledOnce();
    } else {
      expect(terminal.paste).not.toHaveBeenCalled(); expect(terminal.focus).not.toHaveBeenCalled();
      expect(mocks.clipboardCancel).toHaveBeenCalledWith(mocks.clipboardRead.mock.calls[0][0].token);
    }
    if (outcome !== 'unmounted') {
      expect(paste).toHaveProperty('disabled',false); expect(paste.getAttribute('aria-busy')).toBe('false');
    }
    if (outcome !== 'current failure') expect(reportError).not.toHaveBeenCalled();
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });
  it.each(['active tab', 'connection', 'terminal context'] as const)('discards a held paste after %s leaves and returns to the original state', async change => {
    let finish!: (value: string) => void;
    vi.mocked(navigator.clipboard.readText).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const original = { id: 'clipboard-original', name: 'Host', connected: true, terminal } as unknown as LiveSession;
    const reportError = vi.fn();
    const view = render(<TerminalPane session={original} active reportError={reportError} />);
    fireEvent.click(screen.getByRole('button', {name: 'paste'}));
    expect(navigator.clipboard.readText).toHaveBeenCalledOnce();
    const replacement = change === 'terminal context' ? {...original, terminal: createMockTerminal()} as unknown as LiveSession
      : change === 'connection' ? {...original, connected: false} : original;
    view.rerender(<TerminalPane session={replacement} active={change !== 'active tab'} reportError={reportError} />);
    view.rerender(<TerminalPane session={original} active reportError={reportError} />);
    await act(async () => finish('literal delayed clipboard'));
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
  it.each(['toolbar','custom D-pad'] as const)('fences held timed %s failures and dispatch on the same stale mount after lock/unlock',async source=>{
    savePreferences({...defaults,toolbar:[...defaults.toolbar,'dpad'],chords:[{label:'Timed',keys:'C-b T'}],dpadCorners:{...defaults.dpadCorners,left:'custom'},gestureChords:{cornerLeft:'C-b T'}});
    let reject!:(error:Error)=>void;
    mocks.writeSequence.mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
    const reportError=vi.fn();
    render(<TerminalPane session={{id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession} active reportError={reportError} />);
    if(source==='custom D-pad')fireEvent.click(screen.getByRole('button',{name:'dpad'}));
    const send=()=>fireEvent.click(screen.getByRole('button',{name:source==='toolbar'?'Timed':'D-pad left corner'}));
    send();expect(mocks.writeSequence).toHaveBeenCalledTimes(1);
    access(true);access();
    await act(async()=>reject(new Error('old request failure')));
    expect(reportError).not.toHaveBeenCalled();terminal.focus.mockClear();
    send();await act(async()=>{});
    expect(mocks.writeSequence).toHaveBeenCalledTimes(1);expect(reportError).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
  });
  it('does not paste an old clipboard read into the fresh terminal handler after lock and unlock',async()=>{
    let resolve!: (text:string)=>void;
    const pending=new Promise<string>(done=>{resolve=done;});
    vi.mocked(navigator.clipboard.readText).mockReturnValueOnce(pending);
    let receive:((data:string)=>void)|undefined;
    terminal.onData=callback=>{receive=callback;return{dispose(){if(receive===callback)receive=undefined;}};};
    terminal.paste.mockImplementation(text=>receive?.(text));
    const old=mount();
    fireEvent.click(screen.getByRole('button',{name:'paste'}));
    expect(navigator.clipboard.readText).toHaveBeenCalledTimes(1);
    access(true);old.unmount();access();mount();
    terminal.focus.mockClear();
    await act(async()=>{resolve('stale clipboard');await pending;});
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
    vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce('fresh clipboard');
    fireEvent.click(screen.getByRole('button',{name:'paste'}));
    await waitFor(()=>expect(mocks.write).toHaveBeenCalledExactlyOnceWith('ssh','fresh clipboard'));
  });
  it('fences a deferred clipboard read when the pane remains mounted across an access change',async()=>{
    let resolve!: (text:string)=>void;
    const pending=new Promise<string>(done=>{resolve=done;});
    vi.mocked(navigator.clipboard.readText).mockReturnValueOnce(pending);
    mount();
    fireEvent.click(screen.getByRole('button',{name:'paste'}));
    access(true);access();terminal.focus.mockClear();
    await act(async()=>{resolve('old lease');await pending;});
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
  });
  it('rejects stale clipboard starts and suppresses late read and write errors',async()=>{
    let rejectRead!: (reason:Error)=>void, rejectWrite!: (reason:Error)=>void;
    vi.mocked(navigator.clipboard.readText).mockReturnValueOnce(new Promise((_,reject)=>{rejectRead=reject;}));
    vi.mocked(navigator.clipboard.writeText).mockReturnValueOnce(new Promise((_,reject)=>{rejectWrite=reject;}));
    const reportError=vi.fn();
    render(<TerminalPane session={{id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession} active reportError={reportError} />);
    fireEvent.click(screen.getByRole('button',{name:'paste'}));
    fireEvent.click(screen.getByRole('button',{name:'Copy'}));
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('selected');
    access(true);access();
    fireEvent.click(screen.getByRole('button',{name:'paste'}));
    fireEvent.click(screen.getByRole('button',{name:'Copy'}));
    expect(navigator.clipboard.readText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    await act(async()=>{rejectRead(new Error('old read'));rejectWrite(new Error('old write'));});
    expect(reportError).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });
  it.each([
    ['nextZellijTab','nextTab'],['previousZellijTab','previousTab'],
    ['nextZellijPane','nextPane'],['previousZellijPane','previousPane'],
  ] as const)('routes %s through the attached Zellij command without writing terminal bytes', async (action, command) => {
    savePreferences({...defaults,bodyGestures:{...defaults.bodyGestures,swipeLeft:action}});
    render(<StrictMode><TerminalPane session={{id:'ssh',name:'Host',connected:true,attached:{kind:'zellij',name:"literal'$(touch nope)"},terminal} as unknown as LiveSession} active reportError={vi.fn()} /></StrictMode>);
    const canvas=screen.getByLabelText('Terminal for Host');
    fireEvent.pointerDown(canvas,{pointerId:1,pointerType:'touch',clientX:200,clientY:100});
    fireEvent.pointerUp(canvas,{pointerId:1,pointerType:'touch',clientX:100,clientY:100});
    await waitFor(()=>expect(mocks.zellijNavigate).toHaveBeenCalledWith('ssh',"literal'$(touch nope)",command));
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
  });
  it('serializes two-finger Zellij actions, reports failures and permits another attempt', async () => {
    savePreferences({...defaults,pinchZoom:false,gestures:{...defaults.gestures,left:'nextZellijPane'}});
    const {reject, reportError, canvas} = pendingZellijNavigation();
    const swipe=()=>swipeTwoLeft(canvas);
    swipe(); swipe();
    expect(mocks.zellijNavigate).toHaveBeenCalledTimes(1);
    await act(async()=>reject(new Error('Fixture unavailable')));
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('Fixture unavailable'));
    swipe();
    await waitFor(()=>expect(mocks.zellijNavigate).toHaveBeenCalledTimes(2));
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
  });
  it('rejects Zellij navigation on plain, local and other multiplexer terminals and ignores inactive, disconnected, selected or composing views', () => {
    savePreferences({...defaults,bodyGestures:{...defaults.bodyGestures,swipeLeft:'nextZellijTab'}});
    const reportError=vi.fn();
    const session={id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession;
    const view=render(<TerminalPane session={session} active reportError={reportError} />);
    const swipe=()=>{
      const canvas=screen.getByLabelText('Terminal for Host');
      fireEvent.pointerDown(canvas,{pointerId:1,pointerType:'touch',clientX:200,clientY:100});
      fireEvent.pointerUp(canvas,{pointerId:1,pointerType:'touch',clientX:100,clientY:100});
    };
    swipe();
    for(const kind of ['tmux','herdr','zellij'] as const){
      session.attached={kind,name:'test'}; session.local=kind==='zellij'?true:undefined;
      view.rerender(<TerminalPane session={session} active reportError={reportError} />); swipe();
    }
    expect(reportError).toHaveBeenCalledTimes(4);
    session.local=undefined;
    view.rerender(<TerminalPane session={session} active={false} reportError={reportError} />); swipe();
    session.connected=false;
    view.rerender(<TerminalPane session={session} active reportError={reportError} />); swipe();
    session.connected=true;
    view.rerender(<TerminalPane session={session} active reportError={reportError} />);
    terminal.hasSelection.mockReturnValue(true); swipe(); terminal.hasSelection.mockReturnValue(false);
    fireEvent.compositionStart(screen.getByLabelText('Terminal for Host')); swipe();
    expect(reportError).toHaveBeenCalledTimes(4);
    expect(mocks.zellijNavigate).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
  });
  it('discards old Zellij errors and starts after an access generation changes', async () => {
    savePreferences({...defaults,bodyGestures:{...defaults.bodyGestures,swipeLeft:'nextZellijTab'}});
    const {reject, reportError, canvas} = pendingZellijNavigation();
    const swipe=()=>{
      fireEvent.pointerDown(canvas,{pointerId:1,pointerType:'touch',clientX:200,clientY:100});
      fireEvent.pointerUp(canvas,{pointerId:1,pointerType:'touch',clientX:100,clientY:100});
    };
    swipe();
    access(true); access();
    await act(async()=>reject(new Error('Old native navigation failure')));
    swipe();
    await act(async()=>{});
    expect(mocks.zellijNavigate).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });
  it('suppresses a late navigation failure after the terminal becomes inactive', async () => {
    savePreferences({...defaults,bodyGestures:{...defaults.bodyGestures,swipeLeft:'nextZellijTab'}});
    const {reject, reportError, canvas, session, view} = pendingZellijNavigation();
    fireEvent.pointerDown(canvas,{pointerId:1,pointerType:'touch',clientX:200,clientY:100});
    fireEvent.pointerUp(canvas,{pointerId:1,pointerType:'touch',clientX:100,clientY:100});
    view.rerender(<TerminalPane session={session} active={false} reportError={reportError} />);
    await act(async()=>reject({kind:'fixture',message:'Late private error'}));
    expect(reportError).not.toHaveBeenCalled();
    expect(mocks.zellijNavigate).toHaveBeenCalledTimes(1);
  });
  it("distinguishes configured single, double and triple taps without firing lower-count actions", () => {
    vi.useFakeTimers();
    savePreferences({...defaults, bodyGestures: {...defaults.bodyGestures, tap: "escape", doubleTap: "tab", tripleTap: "interrupt"}});
    mount();
    const canvas = screen.getByLabelText("Terminal for Host");
    const tap = () => {fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10}); fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10});};
    tap(); act(() => vi.advanceTimersByTime(100)); tap(); act(() => vi.advanceTimersByTime(100)); tap();
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x03");
    tap(); act(() => vi.advanceTimersByTime(351));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x1b");
    tap(); act(() => vi.advanceTimersByTime(100)); tap(); act(() => vi.advanceTimersByTime(351));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\t");
  });
  it("cancels delayed tap actions on selection, composition, long presses and scrolling", () => {
    vi.useFakeTimers();
    savePreferences({...defaults, bodyGestures: {...defaults.bodyGestures, tap: "escape", doubleTap: "tab"}});
    mount();
    const canvas = screen.getByLabelText("Terminal for Host");
    const down = () => fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10});
    const up = () => fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10});
    down(); up(); fireEvent.compositionStart(canvas); act(() => vi.advanceTimersByTime(400)); fireEvent.compositionEnd(canvas);
    down(); act(() => vi.advanceTimersByTime(600)); up(); act(() => vi.advanceTimersByTime(400));
    down(); fireEvent.pointerMove(canvas, {pointerId: 1, pointerType: "touch", clientX: 10, clientY: 100}); up(); act(() => vi.advanceTimersByTime(400));
    down(); up(); terminal.hasSelection.mockReturnValue(true); act(() => vi.advanceTimersByTime(400));
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
  });
  it("dispatches session swipes and sends exact per-slot custom two-finger chords", () => {
    savePreferences({...defaults, pinchZoom: false, bodyGestures: {...defaults.bodyGestures, swipeLeft: "nextSession"}, gestures: {...defaults.gestures, left: "custom"}, gestureChords: {twoLeft: "C-b, T"}});
    const action = vi.fn(); window.addEventListener("lazysh-terminal-action", action);
    mount();
    const canvas = screen.getByLabelText("Terminal for Host");
    fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 200, clientY: 100});
    fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100});
    expect(action.mock.calls[0][0].detail).toEqual({sessionId: "ssh", action: "nextSession"});
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
    swipeTwoLeft(canvas, false);
    expect(mocks.writeSequence).toHaveBeenCalledWith("ssh", ["\x02","T"]);
    window.removeEventListener("lazysh-terminal-action", action);
  });
  it("supports configured D-pad corners and a Control lock released explicitly", () => {
    savePreferences({...defaults, toolbar: [...defaults.toolbar, "dpad"], dpadCorners: {left: "custom", right: "backspace"}, gestureChords: {cornerLeft: "C-b, T"}});
    mount();
    fireEvent.click(screen.getByRole("button", {name: "dpad"}));
    fireEvent.click(screen.getByRole("button", {name: "D-pad left corner"}));
    expect(mocks.writeSequence).toHaveBeenLastCalledWith("ssh", ["\x02","T"]);
    fireEvent.click(screen.getByRole("button", {name: "D-pad right corner"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x7f");
    fireEvent.click(screen.getByRole("button", {name: "ctrl"}));
    fireEvent.click(screen.getByRole("button", {name: "ctrl"}));
    fireEvent.click(screen.getByRole("button", {name: "c"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x03");
    fireEvent.click(screen.getByRole("button", {name: "d"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x04");
    fireEvent.click(screen.getByRole("button", {name: "ctrl · lock"}));
    fireEvent.click(screen.getByRole("button", {name: "c"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "c");
  });
  it("uses terminal modifier sequences for toolbar arrows and Backspace", () => {
    savePreferences({...defaults, toolbar: [...defaults.toolbar, "backspace"]});
    mount();
    fireEvent.click(screen.getByRole("button", {name: "ctrl"}));
    fireEvent.click(screen.getByRole("button", {name: "Arrow left"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x1b[1;5D");
    fireEvent.click(screen.getByRole("button", {name: "Alt"}));
    fireEvent.click(screen.getByRole("button", {name: "Arrow right"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x1b[1;3C");
    fireEvent.click(screen.getByRole("button", {name: "ctrl"}));
    fireEvent.click(screen.getByRole("button", {name: "backspace"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\b");
  });
  it("stages only bounded drafts for this exact session and preserves existing text without sending", () => {
    mount();
    for (const detail of [null, {sessionId: "other", text: "wrong"}, {sessionId: "ssh", text: 42}, {sessionId: "ssh", text: "a".repeat(65537)}]) {
      act(() => {window.dispatchEvent(new CustomEvent("lazysh-prompt-draft", {detail}));});
    }
    expect(screen.queryByLabelText("Compose text")).toBeNull();
    act(() => {window.dispatchEvent(new CustomEvent("lazysh-prompt-draft", {detail: {sessionId: "ssh", text: "Review file.ts:7"}}));});
    const input = screen.getByLabelText("Compose text") as HTMLTextAreaElement;
    expect(input.value).toBe("Review file.ts:7");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, {target: {value: "My existing prompt"}});
    act(() => {window.dispatchEvent(new CustomEvent("lazysh-prompt-draft", {detail: {sessionId: "ssh", text: "Image: /tmp/photo.png"}}));});
    expect(input.value).toBe("My existing prompt\n\nImage: /tmp/photo.png");
    fireEvent.change(input, {target: {value: "x".repeat(65530)}});
    act(() => {window.dispatchEvent(new CustomEvent("lazysh-prompt-draft", {detail: {sessionId: "ssh", text: "overflow"}}));});
    expect(input.value).toBe("x".repeat(65530));
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
  });
  it("routes vertical touch through xterm wheel handling even with configurable gestures disabled", () => {
    savePreferences({...defaults, pinchZoom: false, gestures: {left:'none',right:'none',up:'none',down:'none'}, bodyGestures: {...defaults.bodyGestures,tap:'none',doubleTap:'none',tripleTap:'none',swipeLeft:'none',swipeRight:'none'}});
    const {view, canvas, wheels, touch} = touchScrollFixture();
    touch('touchstart',100,100);
    expect(touch('touchmove',101,70)).toBe(false);
    touch('touchmove',102,130);
    expect(wheels.map(event=>[event.deltaY,event.clientX,event.clientY])).toEqual([[30,100,100],[-60,100,100]]);
    touch('touchend',102,130);
    touch('touchmove',102,160);
    expect(wheels).toHaveLength(2);
    touch('touchstart',100,100); touch('touchmove',180,103);
    expect(wheels).toHaveLength(2);
    terminal.hasSelection.mockReturnValue(true);
    touch('touchstart',100,100); touch('touchmove',100,160);
    expect(wheels).toHaveLength(2);
    terminal.hasSelection.mockReturnValue(false);
    fireEvent.compositionStart(canvas);
    touch('touchstart',100,100); touch('touchmove',100,160);
    expect(wheels).toHaveLength(3);
    fireEvent.compositionEnd(canvas);
    view.rerender(<TerminalPane session={{id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession} active={false} reportError={vi.fn()} />);
    touch('touchstart',100,100); touch('touchmove',100,160);
    expect(wheels).toHaveLength(3);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('uses touch distance rather than move frequency for mouse wheel notches, preserving direction and gesture ownership',()=>{
    terminal.modes.mouseTrackingMode='vt200';
    const {target,wheels,touch}=touchScrollFixture();
    const surface=document.createElement('div');surface.className='xterm-screen';
    surface.getBoundingClientRect=()=>({height:480} as DOMRect);target.append(surface);
    for(const segments of [2,8]) {
      wheels.length=0;touch('touchstart',100,300);
      for(let step=1;step<=segments;step++)touch('touchmove',100,300-180*step/segments);
      expect(wheels.map(event=>[event.deltaY,event.deltaMode,event.clientX,event.clientY])).toEqual(Array.from({length:9},()=>[1,WheelEvent.DOM_DELTA_LINE,100,300]));
      touch('touchend',100,120);
    }
    wheels.length=0;touch('touchstart',100,300);touch('touchmove',100,290);
    expect(wheels).toHaveLength(0);
    touch('touchmove',100,295);touch('touchmove',100,310);
    expect(wheels.map(event=>event.deltaY)).toEqual([-1]);
    touch('touchcancel',100,310);touch('touchmove',100,100);
    expect(wheels).toHaveLength(1);
    wheels.length=0;touch('touchstart',100,1500);touch('touchmove',100,300);
    expect(wheels).toHaveLength(10);
    touch('touchmove',100,299);expect(wheels).toHaveLength(20);
    touch('touchend',100,299);wheels.length=0;
    touch('touchstart',100,300);touch('touchmove',100,290);expect(wheels).toHaveLength(0);
  });
  it('keeps one continuous drag routed to its original pane across boundaries and reversal until end or cancel', () => {
    const {wheels, touch} = touchScrollFixture();
    touch('touchstart',140,180);
    const trace=[[142,168],[144,145],[245,100],[280,55],[281,12],[280,90],[141,190]];
    for (const [x,y] of trace) expect(touch('touchmove',x,y)).toBe(false);
    // Herdr dispatches each wheel to the pane under that report's coordinates.
    const originalPane = wheels.filter(event=>event.clientX>=80&&event.clientX<200&&event.clientY>=120&&event.clientY<300);
    expect(originalPane).toHaveLength(trace.length);
    expect(wheels.map(event=>[event.clientX,event.clientY])).toEqual(trace.map(()=>[140,180]));
    expect(wheels.map(event=>event.deltaY)).toEqual([12,23,45,45,43,-78,-100]);
    touch('touchend',141,190); touch('touchmove',141,210);
    expect(wheels).toHaveLength(trace.length);
    touch('touchstart',310,240); touch('touchmove',315,200);
    expect([wheels.at(-1)!.clientX,wheels.at(-1)!.clientY,wheels.at(-1)!.deltaY]).toEqual([310,240,40]);
    touch('touchcancel',315,200); touch('touchmove',315,100);
    expect(wheels).toHaveLength(trace.length+1);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("preserves system touch gestures in screen-reader mode and reserves configured multitouch", () => {
    savePreferences({...defaults, screenReader: true});
    const view = mount();
    let canvas = screen.getByLabelText("Terminal for Host");
    expect(canvas.style.touchAction).toBe("auto");
    expect(canvas.classList.contains("terminal-screen-reader")).toBe(true);
    const accessiblePinch = new TouchEvent("touchmove", {bubbles: true, cancelable: true, touches: [{identifier: 1}, {identifier: 2}] as Touch[]});
    canvas.dispatchEvent(accessiblePinch);
    expect(accessiblePinch.defaultPrevented).toBe(false);
    view.unmount();
    savePreferences({...defaults});
    mount();
    canvas = screen.getByLabelText("Terminal for Host");
    expect(canvas.classList.contains("terminal-screen-reader")).toBe(false);
    const oneTouch = new TouchEvent("touchmove", {bubbles: true, cancelable: true, touches: [{identifier: 1}] as Touch[]});
    canvas.dispatchEvent(oneTouch);
    expect(oneTouch.defaultPrevented).toBe(false);
    const twoTouches = new TouchEvent("touchmove", {bubbles: true, cancelable: true, touches: [{identifier: 1}, {identifier: 2}] as Touch[]});
    canvas.dispatchEvent(twoTouches);
    expect(twoTouches.defaultPrevented).toBe(true);
  });
  it("handles two-touch swipes without changing font size, and clamps pinch zoom", () => {
    savePreferences({...defaults, gestures: {...defaults.gestures, left: "tab"}});
    mount();
    const canvas = screen.getByLabelText("Terminal for Host");
    swipeTwoLeft(canvas);
    expect(mocks.write).toHaveBeenCalledWith("ssh", "\t");
    expect(getPreferences().fontSize).toBe(14);
    fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100});
    fireEvent.pointerDown(canvas, {pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100});
    fireEvent.pointerMove(canvas, {pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100});
    fireEvent.pointerMove(canvas, {pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100});
    expect(getPreferences().fontSize).toBe(32);
    fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100});
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("leaves selection, composition and single-touch gestures alone; sends configured chords only on click", () => {
    savePreferences({...defaults, gestures: {...defaults.gestures, left: "tab"}, chords: [{label: "Next window", keys: "Ctrl+b n"}]});
    mount();
    const canvas = screen.getByLabelText("Terminal for Host");
    terminal.hasSelection.mockReturnValue(true);
    fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 100});
    fireEvent.pointerDown(canvas, {pointerId: 2, pointerType: "touch", clientX: 200});
    fireEvent.pointerMove(canvas, {pointerId: 2, pointerType: "touch", clientX: 400});
    expect(getPreferences().fontSize).toBe(14);
    terminal.hasSelection.mockReturnValue(false);
    fireEvent.compositionStart(canvas);
    fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 100});
    fireEvent.pointerDown(canvas, {pointerId: 2, pointerType: "touch", clientX: 200});
    fireEvent.pointerUp(canvas, {pointerId: 2, pointerType: "touch", clientX: 400});
    expect(getPreferences().fontSize).toBe(14);
    fireEvent.compositionEnd(canvas);
    fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 100});
    fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 0});
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Next window"}));
    expect(mocks.writeSequence).toHaveBeenCalledWith("ssh", ["\x02","n"]);
  });
  it("requires one explicit approval per remote clipboard write and ignores read requests", () => {
    mount();
    act(() => {osc("c;?");});
    expect(screen.queryByRole("region", {name: "Remote clipboard request"})).toBeNull();
    act(() => {osc("c;aGVsbG8=");});
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    // A later escape cannot replace the exact text the user is reviewing.
    act(() => {osc("c;c3dhcHBlZA==");});
    expect(screen.getByText("hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {name: "Allow this copy"}));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
    act(() => {osc("c;c2Vjb25k");});
    fireEvent.click(screen.getByRole("button", {name: "Deny"}));
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
  });
  it("requires clicking a URL before offering copy and rejects non-HTTP links", () => {
    mount();
    act(() => {mocks.link?.(new MouseEvent("click"), "javascript:alert(1)");});
    expect(screen.queryByRole("region", {name: "Terminal link"})).toBeNull();
    act(() => {mocks.link?.(new MouseEvent("click"), "https://example.com/a");});
    fireEvent.click(screen.getByRole("button", {name: "Copy URL"}));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://example.com/a");
  });
  it("opens only the confirmed HTTP URL and preserves a later selected link", async () => {
    let finish: (() => void) | undefined;
    mocks.openWebUrl.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    mount();
    act(() => {mocks.link?.(new MouseEvent('click'), 'HTTPS://Example.COM');});
    expect(screen.getByText('https://example.com/')).toBeTruthy();
    expect(mocks.openWebUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(mocks.openWebUrl).toHaveBeenCalledOnce();
    expect(mocks.openWebUrl).toHaveBeenCalledWith('https://example.com/');
    act(() => {mocks.link?.(new MouseEvent('click'), 'https://second.example/');});
    await act(async () => {finish?.();});
    expect(screen.getByText('https://second.example/')).toBeTruthy();
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
  });
  it("keeps the confirmation available when the OS browser cannot open the link", async () => {
    mocks.openWebUrl.mockRejectedValue('No browser is installed.');
    const reportError = vi.fn();
    render(<TerminalPane session={{id: 'ssh', name: 'Host', connected: true, terminal} as unknown as LiveSession} active reportError={reportError} />);
    act(() => {mocks.link?.(new MouseEvent('click'), 'https://example.com/a');});
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith('No browser is installed.'));
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeTruthy();
  });
  it("rejects userinfo, ambiguous URLs and non-browser protocols before confirmation", () => {
    for (const uri of ['https://user:pass@example.com', 'https://@example.com', 'https:///example.com', 'https://example.com\\@evil.example', 'https://exa\nmple.com', 'https://example.com:99999', 'file:///tmp/file', 'javascript:alert(1)', 'mailto:user@example.com', `https://example.com/${'x'.repeat(4096)}`]) expect(terminalWebUrl(uri)).toBeUndefined();
    expect(terminalWebUrl('http://localhost:3000/@user?x=%20')).toBe('http://localhost:3000/@user?x=%20');
  });
  it("keeps snippets editable and uses xterm paste for composition, then searches retained history", () => {
    savePreferences({...defaults, snippets: [{label: "project", text: "cd hello"}]});
    mount();
    fireEvent.click(screen.getByRole("button", {name: "project"}));
    expect(terminal.paste).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Compose text") as HTMLTextAreaElement).value).toBe("cd hello");
    fireEvent.change(screen.getByLabelText("Compose text"), {target: {value: "你好"}});
    fireEvent.click(screen.getByRole("button", {name: "Paste draft"}));
    expect(terminal.paste).toHaveBeenCalledWith("你好");
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.writeSequence).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Find"}));
    fireEvent.change(screen.getByLabelText("Search terminal history"), {target: {value: "world"}});
    fireEvent.click(screen.getByRole("button", {name: "Next"}));
    expect(terminal.scrollToLine).toHaveBeenCalledWith(1);
    expect(within(screen.getByLabelText("Search terminal history").closest("form")!).getByRole("status").textContent).toBe("Match on line 2");
  });
});

function pendingZellijNavigation() {
  let reject!: (error: unknown) => void;
  mocks.zellijNavigate.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const reportError = vi.fn();
  const session = {id:'ssh',name:'Host',connected:true,attached:{kind:'zellij',name:'test'},terminal} as unknown as LiveSession;
  const view = render(<TerminalPane session={session} active reportError={reportError} />);
  return {reject: (error: unknown) => reject(error), reportError, session, view, canvas: screen.getByLabelText('Terminal for Host')};
}
function swipeTwoLeft(canvas: HTMLElement, releaseSecond = true) {
  fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100});
  fireEvent.pointerDown(canvas, {pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100});
  fireEvent.pointerMove(canvas, {pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100});
  fireEvent.pointerMove(canvas, {pointerId: 2, pointerType: "touch", clientX: 100, clientY: 100});
  fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100});
  if (releaseSecond) fireEvent.pointerUp(canvas, {pointerId: 2, pointerType: "touch", clientX: 100, clientY: 100});
}

function LocaleTerminal() {
  useUi();
  const [session]=useState(()=>({id:"ssh",name:"Host <raw> {{name}} 中文",connected:true,terminal} as unknown as LiveSession));
  const [error,setError]=useState<UiErrorCause>("");
  return <><TerminalPane session={session} active reportError={setError}/>{error && <p role="alert">{uiErrorText(error)}</p>}</>;
}
it.each([
  ["pt-BR","Compor","Compor texto","Colar rascunho"],
  ["es","Redactar","Redactar texto","Pegar borrador"],
] as const)("renders actual %s terminal controls while retaining draft and terminal identity",async(locale,compose,label,paste)=>{
  render(<LocaleTerminal/>);
  const canvas=document.querySelector(".terminal-canvas");
  const registrations=terminal.parser.registerOscHandler.mock.calls.length;
  await act(async()=>{await uiI18n.changeLanguage(locale);});
  fireEvent.click(screen.getByRole("button",{name:compose}));
  const draft=screen.getByRole("textbox",{name:label});
  fireEvent.change(draft,{target:{value:"raw Ctrl+b <draft> {{name}} 中文"}});draft.focus();
  await act(async()=>{await uiI18n.changeLanguage("en");});
  expect(screen.getByRole("textbox",{name:"Compose text"})).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe("raw Ctrl+b <draft> {{name}} 中文");expect(document.activeElement).toBe(draft);
  expect(document.querySelector(".terminal-canvas")).toBe(canvas);
  expect(terminal.parser.registerOscHandler).toHaveBeenCalledTimes(registrations);
  expect(terminal.paste).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
  await act(async()=>{await uiI18n.changeLanguage(locale);});
  fireEvent.click(screen.getByRole("button",{name:paste}));
  expect(terminal.paste).toHaveBeenCalledWith("raw Ctrl+b <draft> {{name}} 中文");
});

it('retains search result, modifier state and exact input bytes across language changes',async()=>{
  render(<LocaleTerminal/>);
  const ctrl=screen.getByRole('button',{name:'ctrl'});fireEvent.click(ctrl);fireEvent.click(ctrl);
  fireEvent.click(screen.getByRole('button',{name:'Find'}));
  const input=screen.getByRole('textbox',{name:'Search terminal history'});
  fireEvent.change(input,{target:{value:'world'}});input.focus();fireEvent.submit(input.closest('form')!);
  expect(screen.getByText('Match on line 2')).toBeTruthy();
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(screen.getByText('Resultado na linha 2')).toBeTruthy();
  expect(screen.getByRole('textbox',{name:'Buscar no histórico do terminal'})).toBe(input);
  expect((input as HTMLInputElement).value).toBe('world');expect(document.activeElement).toBe(input);
  expect(terminal.select).toHaveBeenCalledTimes(1);expect(mocks.write).not.toHaveBeenCalled();
  await act(async()=>{await uiI18n.changeLanguage('es');});
  expect(screen.getByText('Coincidencia en la línea 2')).toBeTruthy();
  expect(ctrl.textContent).toBe('ctrl · bloqueado');
  fireEvent.click(screen.getByRole('button',{name:'c'}));expect(mocks.write).toHaveBeenCalledWith('ssh','\x03');
  fireEvent.change(input,{target:{value:'raw-no-match'}});fireEvent.submit(input.closest('form')!);
  await act(async()=>{await uiI18n.changeLanguage('en');});
  expect(screen.getByText('No match in retained history.')).toBeTruthy();
});
it('keeps one explicit OSC copy through a held write and retranslates only its local failure',async()=>{
  let reject!:(error:Error)=>void;
  vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
  render(<LocaleTerminal/>);
  const raw='raw Ctrl+b {{clipboard}} 中文';
  act(()=>{osc(`c;${btoa(String.fromCharCode(...new TextEncoder().encode(raw)))}`);});
  const region=screen.getByRole('region',{name:'Remote clipboard request'});
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(screen.getByRole('region',{name:'Solicitação remota da área de transferência'})).toBe(region);
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Permitir esta cópia'}));
  await act(async()=>{await uiI18n.changeLanguage('es');});
  expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);expect(navigator.clipboard.writeText).toHaveBeenCalledWith(raw);
  await act(async()=>{reject(new Error('owned clipboard rejection'));});
  expect(screen.getByRole('alert').textContent).toContain('El acceso al portapapeles no estaba disponible.');
  await act(async()=>{await uiI18n.changeLanguage('en');});
  expect(screen.getByRole('alert').textContent).toBe('Clipboard access was unavailable. Use your system copy menu.');
  expect(terminal.parser.registerOscHandler).toHaveBeenCalledTimes(1);
  expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
});
it('retains a held paste and the same link operation without translating raw diagnostics',async()=>{
  let resolve!:(text:string)=>void;
  vi.mocked(navigator.clipboard.readText).mockImplementationOnce(()=>new Promise<string>(done=>{resolve=done;}));
  render(<LocaleTerminal/>);
  fireEvent.click(screen.getByRole('button',{name:'paste'}));
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(navigator.clipboard.readText).toHaveBeenCalledTimes(1);expect(terminal.paste).not.toHaveBeenCalled();
  await act(async()=>{resolve('raw <paste> {{text}} 中文');});
  expect(terminal.paste).toHaveBeenCalledWith('raw <paste> {{text}} 中文');
  let reject!:(error:string)=>void;
  mocks.openWebUrl.mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
  act(()=>{mocks.link!(new MouseEvent('click'),'https://example.com/raw');});
  fireEvent.click(screen.getByRole('button',{name:'Abrir no navegador'}));
  const opening=screen.getByRole('button',{name:'Abrindo…'});
  await act(async()=>{await uiI18n.changeLanguage('es');});
  expect(screen.getByRole('button',{name:'Abriendo…'})).toBe(opening);
  expect(mocks.openWebUrl).toHaveBeenCalledTimes(1);expect(mocks.openWebUrl).toHaveBeenCalledWith('https://example.com/raw');
  const raw='RAW denied <native> {{token}} 中文';await act(async()=>{reject(raw);});
  expect(screen.getByRole('alert').textContent).toBe(raw);
  await act(async()=>{await uiI18n.changeLanguage('en');});
  expect(screen.getByRole('alert').textContent).toBe(raw);expect(mocks.openWebUrl).toHaveBeenCalledTimes(1);
});

it('rerenders retained font warning data without recreating its node or terminal handlers',async()=>{
  const fonts=await import('./fonts');
  const snapshot={...fonts.getDeviceFonts(),selection:{primary:'11111111-1111-4111-8111-111111111111'},warnings:[{kind:'missing',role:'primary'} as const]};
  const subscription=vi.spyOn(fonts,'useDeviceFonts').mockReturnValue(snapshot);
  try {
    mount();const note=screen.getByRole('note');const addons=terminal.loadAddon.mock.calls.length;
    const handlers=terminal.parser.registerOscHandler.mock.calls.length;
    for(const locale of ['pt-BR','es','en']){
      await act(async()=>{await uiI18n.changeLanguage(locale);});
      expect(screen.getByRole('note')).toBe(note);
      expect(note.textContent).toBe(fonts.fontWarningText(snapshot.warnings[0]));
      expect(terminal.loadAddon).toHaveBeenCalledTimes(addons);
      expect(terminal.parser.registerOscHandler).toHaveBeenCalledTimes(handlers);
      expect(mocks.write).not.toHaveBeenCalled();expect(mocks.writeSequence).not.toHaveBeenCalled();
    }
  }finally{subscription.mockRestore();}
});

it.each(['key','chord'] as const)('retains a synchronous %s parser cause without repeating terminal dispatch',async(branch)=>{
  const parser=await import('./preferences');const{LocalUiError}=await import('./i18n/localError');
  savePreferences({...defaults,chords:[{label:'Parser fixture',keys:'C-z 2'}]});render(<LocaleTerminal/>);
  if(branch==='key')fireEvent.click(screen.getByRole('button',{name:'ctrl'}));
  const parse=vi.spyOn(parser,branch==='key'?'parseChord':'parseChordSteps').mockImplementation(()=>{throw new LocalUiError('validationUnknownKeyValue1','{{<literal>}}');});
  try{
    fireEvent.click(screen.getByRole('button',{name:branch==='key'?'tab':'Parser fixture'}));
    expect(parse).toHaveBeenCalledTimes(1);
    for(const locale of ['pt-BR','es','en']){
      await act(async()=>{await uiI18n.changeLanguage(locale);});
      expect(screen.getByRole('alert').textContent).toBe((await import('./i18n/core')).t('validationUnknownKeyValue1',{value1:'{{<literal>}}'}));
      expect(parse).toHaveBeenCalledTimes(1);expect(mocks.write).not.toHaveBeenCalled();expect(mocks.writeSequence).not.toHaveBeenCalled();
    }
  }finally{parse.mockRestore();}
});
it.each(['key','chord'] as const)('preserves the original raw formatting of the synchronous %s parser catch',async(branch)=>{
  const parser=await import('./preferences');const raw=new Error('RAW parser <{{literal}}>');
  savePreferences({...defaults,chords:[{label:'Raw parser fixture',keys:'F4'}]});render(<LocaleTerminal/>);
  if(branch==='key')fireEvent.click(screen.getByRole('button',{name:'ctrl'}));
  const parse=vi.spyOn(parser,branch==='key'?'parseChord':'parseChordSteps').mockImplementation(()=>{throw raw;});
  try{
    fireEvent.click(screen.getByRole('button',{name:branch==='key'?'tab':'Raw parser fixture'}));
    await act(async()=>{await uiI18n.changeLanguage('es');});
    expect(screen.getByRole('alert').textContent).toBe(branch==='key'?String(raw):raw.message);
  }finally{parse.mockRestore();}
});


describe("extended touch toolbar", () => {
  it("keeps Tab, arrows and Attach momentary and dispatches only once after a touch release", () => {
    vi.useFakeTimers(); const onOpenAttachments=vi.fn();
    render(<TerminalPane session={{id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession} active reportError={vi.fn()} onOpenAttachments={onOpenAttachments} />);
    for (const name of ['tab','Arrow right','Attach']) {
      const button=screen.getByRole('button',{name});
      fireEvent.pointerDown(button,{pointerId:11,pointerType:'touch'});
      fireEvent.pointerUp(button,{pointerId:11,pointerType:'touch'}); fireEvent.click(button,{detail:1});
      expect(button.getAttribute('aria-pressed')).toBeNull();
      act(()=>vi.advanceTimersByTime(1200));
    }
    expect(mocks.write.mock.calls.map(call=>call[1])).toEqual(['\t','\x1b[C']);
    expect(onOpenAttachments).toHaveBeenCalledOnce();
  });
  it("cycles one-shot and locked modifiers, latches navigation Shift, and sends named keys", () => {
    savePreferences({...defaults, toolbar:[...defaults.toolbar,"altgr","F12","PageUp",","]}); mount();
    const key=(name:string)=>screen.getByRole('button',{name});
    fireEvent.click(key('ctrl')); fireEvent.click(key('ctrl'));
    expect(key('ctrl · lock').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(key('F12')); fireEvent.click(key('PageUp'));
    expect(mocks.write.mock.calls.map(call=>call[1])).toEqual(['\x1b[24;5~','\x1b[5;5~']);
    fireEvent.click(key('ctrl · lock')); fireEvent.click(key('Shift')); fireEvent.click(key('Arrow left'));
    expect(mocks.write).toHaveBeenLastCalledWith('ssh','\x1b[1;2D');
    expect(key('Shift').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(key('tab')); expect(mocks.write).toHaveBeenLastCalledWith('ssh','\x1b[Z');
    expect(key('Shift').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(key('AltGr')); fireEvent.click(key('Arrow right'));
    expect(mocks.write).toHaveBeenLastCalledWith('ssh','\x1b[1;7C');
    fireEvent.click(key(',')); expect(mocks.write).toHaveBeenLastCalledWith('ssh',',');
    fireEvent.click(key('ctrl')); fireEvent.click(key('ctrl')); fireEvent.click(key('AltGr'));
    expect(key('ctrl · lock').getAttribute('aria-pressed')).toBe('true');
    expect(key('Alt').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(key('PageUp')); expect(mocks.write).toHaveBeenLastCalledWith('ssh','\x1b[5;7~');
  });
  it("repeats held navigation and stops on pointer cancellation and inactive sessions", () => {
    vi.useFakeTimers(); const view=mount();
    const left=screen.getByRole('button',{name:'Arrow left'});
    fireEvent.pointerDown(left,{pointerId:7});
    expect(mocks.write).not.toHaveBeenCalled();
    act(()=>vi.advanceTimersByTime(560)); expect(mocks.write).toHaveBeenCalledTimes(3);
    fireEvent.pointerCancel(left,{pointerId:7}); act(()=>vi.advanceTimersByTime(800)); expect(mocks.write).toHaveBeenCalledTimes(3);
    fireEvent.pointerDown(left,{pointerId:8});
    view.rerender(<TerminalPane session={{id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession} active={false} reportError={vi.fn()} />);
    act(()=>vi.advanceTimersByTime(800)); expect(mocks.write).toHaveBeenCalledTimes(3);
  });
  it.each((["pending", "repeating"] as const).flatMap(phase=>[true,false].map(notify=>({phase,notify}))))("cancels a $phase held key when hidden (visibility event=$notify)", ({phase,notify}) => {
    vi.useFakeTimers(); mount();
    for (const name of ['ctrl','Alt']) {
      const modifier=screen.getByRole('button',{name}); fireEvent.click(modifier); fireEvent.click(modifier);
    }
    fireEvent.click(screen.getByRole('button',{name:'Shift'}));
    const left=screen.getByRole('button',{name:'Arrow left'});
    fireEvent.pointerDown(left,{pointerId:9});
    if (phase === 'repeating') act(()=>vi.advanceTimersByTime(560));
    const sent=mocks.write.mock.calls.length;
    expect(sent).toBe(phase === 'pending' ? 0 : 3);
    const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true);
    try {
      if(notify)fireEvent(document,new Event('visibilitychange'));
      act(()=>vi.advanceTimersByTime(2000)); expect(mocks.write).toHaveBeenCalledTimes(sent);
      for (const name of ['ctrl','Alt','Shift']) expect(screen.getByRole('button',{name}).getAttribute('aria-pressed')).toBe('false');
      hidden.mockReturnValue(false); fireEvent(document,new Event('visibilitychange'));
      act(()=>vi.advanceTimersByTime(800)); expect(mocks.write).toHaveBeenCalledTimes(sent);
      fireEvent.pointerUp(left,{pointerId:9}); fireEvent.click(left,{detail:1});
      expect(mocks.write).toHaveBeenCalledTimes(sent);
      fireEvent.click(screen.getByRole('button',{name:'Arrow right'}));
      expect(mocks.write).toHaveBeenLastCalledWith('ssh','\x1b[C');
    } finally {hidden.mockRestore();}
  });
  it("opens the existing attachment flow only for an active connected remote terminal", () => {
    const onOpenAttachments=vi.fn();
    const session={id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession;
    const view=render(<TerminalPane session={session} active reportError={vi.fn()} onOpenAttachments={onOpenAttachments} />);
    fireEvent.click(screen.getByRole('button',{name:'Attach'})); expect(onOpenAttachments).toHaveBeenCalledOnce();
    view.rerender(<TerminalPane session={{...session,local:true}} active reportError={vi.fn()} onOpenAttachments={onOpenAttachments} />);
    expect(screen.getByRole('button',{name:'Attach'})).toHaveProperty('disabled',true);
  });
});

it("keeps ordinary terminal input usable and disables virtual modifiers when xterm provenance is unavailable", () => {
  terminal._core.coreService.onUserInput = () => {throw new Error('different xterm internals');}; mount();
  for (const name of ['ctrl','Alt','Shift']) expect(screen.getByRole('button',{name})).toHaveProperty('disabled',true);
  fireEvent.click(screen.getByRole('button',{name:'esc'})); expect(mocks.write).toHaveBeenCalledWith('ssh','\x1b');
});

it("portals only the active terminal controls into the existing header and retains literal drafts", () => {
  const target=document.createElement('div'); document.body.append(target);
  const session={id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession;
  const reportError=vi.fn(); const view=render(<TerminalPane session={session} active reportError={reportError} controlsTarget={target} />);
  try {
    expect(within(target).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(within(target).getByRole('button',{name:'Compose'}));
    fireEvent.change(screen.getByLabelText('Compose text'),{target:{value:'c'}});
    const paste=screen.getByRole('button',{name:'Paste draft'});
    expect(paste.textContent).toBe(''); expect(paste.querySelector('svg')).not.toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Close composer'}));
    fireEvent.click(within(target).getByRole('button',{name:'Compose'}));
    expect(screen.getByLabelText('Compose text')).toHaveProperty('value','c');
    fireEvent.click(screen.getByRole('button',{name:'Paste draft'})); expect(terminal.paste).toHaveBeenCalledWith('c');
    view.rerender(<TerminalPane session={session} active={false} reportError={reportError} controlsTarget={target} />);
    expect(target.childElementCount).toBe(0);
    view.rerender(<TerminalPane session={session} active reportError={reportError} controlsTarget={target} />);
    expect(within(target).getAllByRole('button')).toHaveLength(2);
    view.unmount(); expect(target.childElementCount).toBe(0);
  } finally {target.remove();}
});

it('publishes only the active local overlay Back handler and keeps its draft without sending',()=>{
  const session={id:'ssh',name:'Host',connected:true,terminal} as unknown as LiveSession;
  const onBackChange=vi.fn(),reportError=vi.fn();
  const view=render(<TerminalPane session={session} active reportError={reportError} onBackChange={onBackChange}/>);
  expect(onBackChange).toHaveBeenLastCalledWith('ssh',null);
  fireEvent.click(screen.getByRole('button',{name:'Compose'}));
  fireEvent.change(screen.getByLabelText('Compose text'),{target:{value:'retained draft'}});
  const close=onBackChange.mock.lastCall?.[1] as ()=>boolean;
  act(()=>expect(close()).toBe(true));expect(screen.queryByLabelText('Compose text')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Compose'}));
  expect(screen.getByLabelText('Compose text')).toHaveProperty('value','retained draft');
  const stale=onBackChange.mock.lastCall?.[1] as ()=>boolean;
  view.rerender(<TerminalPane session={session} active={false} reportError={reportError} onBackChange={onBackChange}/>);
  expect(onBackChange).toHaveBeenLastCalledWith('ssh',null);act(()=>expect(stale()).toBe(false));
  view.rerender(<TerminalPane session={session} active reportError={reportError} onBackChange={onBackChange}/>);
  expect(screen.getByLabelText('Compose text')).toHaveProperty('value','retained draft');
  view.unmount();expect(onBackChange).toHaveBeenLastCalledWith('ssh',null);
  expect(mocks.write).not.toHaveBeenCalled();expect(terminal.paste).not.toHaveBeenCalled();
});
