// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import {uiI18n,useUi} from "./i18n/core";
import {uiErrorText,type UiErrorCause} from "./i18n/localError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TerminalPane, { terminalWebUrl } from "./TerminalPane";
import { defaults, getPreferences, savePreferences } from "./preferences";
import type { LiveSession } from "./terminal";
import {accessSnapshot,applyAccessStatus} from './access';
const mocks = vi.hoisted(() => ({write: vi.fn(), writeSequence:vi.fn(), resize: vi.fn(), zellijNavigate: vi.fn(), openWebUrl: vi.fn(), link: undefined as undefined | ((event: MouseEvent, uri: string) => void)}));
vi.mock("./bridge", () => ({api: {write: mocks.write, writeSequence:mocks.writeSequence, resize: mocks.resize, zellijNavigate:mocks.zellijNavigate, openWebUrl: mocks.openWebUrl}}));
vi.mock("@xterm/addon-fit", () => ({FitAddon: class {fit() {} dispose() {}}}));
vi.mock("@xterm/addon-web-links", () => ({WebLinksAddon: class {constructor(handler: typeof mocks.link) {mocks.link = handler;} dispose() {}}}));
let osc: (data: string) => boolean;
let terminal: ReturnType<typeof createMockTerminal>;
function createMockTerminal() {
  return {options: {}, hasSelection: vi.fn(() => false), loadAddon: vi.fn(), parser: {registerOscHandler: vi.fn((_code: number, handler: typeof osc) => {osc = handler; return {dispose() {}};})}, attachCustomKeyEventHandler: vi.fn(), open: vi.fn(), onData: (_callback: (data:string)=>void) => ({dispose() {}}), onResize: () => ({dispose() {}}), focus: vi.fn(), blur: vi.fn(), paste: vi.fn(), getSelection: () => "selected", buffer: {active: {length: 2, getLine: (index: number) => ({translateToString: () => ["hello", "world"][index]})}}, scrollToLine: vi.fn(), select: vi.fn()};
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
describe("terminal interactions", () => {
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
    fireEvent.doubleClick(screen.getByRole("button", {name: "ctrl"}));
    fireEvent.click(screen.getByRole("button", {name: "c"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x03");
    fireEvent.click(screen.getByRole("button", {name: "d"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x04");
    fireEvent.click(screen.getByRole("button", {name: "ctrl · lock"}));
    fireEvent.click(screen.getByRole("button", {name: "c"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "c");
  });
  it("uses terminal modifier sequences for toolbar arrows and Backspace", () => {
    savePreferences({...defaults, toolbar: [...defaults.toolbar, "meta", "backspace"]});
    mount();
    fireEvent.click(screen.getByRole("button", {name: "ctrl"}));
    fireEvent.click(screen.getByRole("button", {name: "Arrow left"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x1b[1;5D");
    fireEvent.click(screen.getByRole("button", {name: "meta"}));
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
  it("preserves system touch gestures in screen-reader mode and single-touch xterm scrolling otherwise", () => {
    savePreferences({...defaults, screenReader: true});
    const view = mount();
    let canvas = screen.getByLabelText("Terminal for Host");
    expect(canvas.style.touchAction).toBe("auto");
    const accessiblePinch = new TouchEvent("touchmove", {bubbles: true, cancelable: true, touches: [{identifier: 1}, {identifier: 2}] as Touch[]});
    canvas.dispatchEvent(accessiblePinch);
    expect(accessiblePinch.defaultPrevented).toBe(false);
    view.unmount();
    savePreferences({...defaults});
    mount();
    canvas = screen.getByLabelText("Terminal for Host");
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
    expect(screen.getByRole("status").textContent).toBe("Match on line 2");
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
  const ctrl=screen.getByRole('button',{name:'ctrl'});fireEvent.doubleClick(ctrl);
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
