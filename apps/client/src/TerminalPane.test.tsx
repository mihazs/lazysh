// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TerminalPane, { terminalWebUrl } from "./TerminalPane";
import { defaults, getPreferences, savePreferences } from "./preferences";
import type { LiveSession } from "./terminal";
const mocks = vi.hoisted(() => ({write: vi.fn(), resize: vi.fn(), openWebUrl: vi.fn(), link: undefined as undefined | ((event: MouseEvent, uri: string) => void)}));
vi.mock("./bridge", () => ({api: {write: mocks.write, resize: mocks.resize, openWebUrl: mocks.openWebUrl}}));
vi.mock("@xterm/addon-fit", () => ({FitAddon: class {fit() {} dispose() {}}}));
vi.mock("@xterm/addon-web-links", () => ({WebLinksAddon: class {constructor(handler: typeof mocks.link) {mocks.link = handler;} dispose() {}}}));
let osc: (data: string) => boolean;
let terminal: ReturnType<typeof createMockTerminal>;
function createMockTerminal() {
  return {options: {}, hasSelection: vi.fn(() => false), loadAddon: vi.fn(), parser: {registerOscHandler: vi.fn((_code: number, handler: typeof osc) => {osc = handler; return {dispose() {}};})}, attachCustomKeyEventHandler: vi.fn(), open: vi.fn(), onData: () => ({dispose() {}}), onResize: () => ({dispose() {}}), focus: vi.fn(), blur: vi.fn(), paste: vi.fn(), getSelection: () => "selected", buffer: {active: {length: 2, getLine: (index: number) => ({translateToString: () => ["hello", "world"][index]})}}, scrollToLine: vi.fn(), select: vi.fn()};
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, options: MouseEventInit & {pointerId?: number; pointerType?: string} = {}) {super(type, options); this.pointerId = options.pointerId ?? 1; this.pointerType = options.pointerType ?? "touch";}
  });
  mocks.write.mockResolvedValue(undefined); mocks.resize.mockResolvedValue(undefined);
  mocks.openWebUrl.mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {callback(); return 1;});
  Object.defineProperty(navigator, "clipboard", {value: {writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue("paste me")}, configurable: true});
  savePreferences({...defaults});
  terminal = createMockTerminal();
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();});
function mount() {
  return render(<TerminalPane session={{id: "ssh", name: "Host", connected: true, terminal} as unknown as LiveSession} active reportError={vi.fn()} />);
}
describe("terminal interactions", () => {
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
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("dispatches session swipes and sends exact per-slot custom two-finger chords", () => {
    savePreferences({...defaults, pinchZoom: false, bodyGestures: {...defaults.bodyGestures, swipeLeft: "nextSession"}, gestures: {...defaults.gestures, left: "custom"}, gestureChords: {twoLeft: "C-b, T"}});
    const action = vi.fn(); window.addEventListener("lazysh-terminal-action", action);
    mount();
    const canvas = screen.getByLabelText("Terminal for Host");
    fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 200, clientY: 100});
    fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100});
    expect(action.mock.calls[0][0].detail).toEqual({sessionId: "ssh", action: "nextSession"});
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100});
    fireEvent.pointerDown(canvas, {pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100});
    fireEvent.pointerMove(canvas, {pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100});
    fireEvent.pointerMove(canvas, {pointerId: 2, pointerType: "touch", clientX: 100, clientY: 100});
    fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100});
    expect(mocks.write).toHaveBeenCalledWith("ssh", "\x02T");
    window.removeEventListener("lazysh-terminal-action", action);
  });
  it("supports configured D-pad corners and a Control lock released explicitly", () => {
    savePreferences({...defaults, toolbar: [...defaults.toolbar, "dpad"], dpadCorners: {left: "custom", right: "backspace"}, gestureChords: {cornerLeft: "C-b, T"}});
    mount();
    fireEvent.click(screen.getByRole("button", {name: "dpad"}));
    fireEvent.click(screen.getByRole("button", {name: "D-pad left corner"}));
    expect(mocks.write).toHaveBeenLastCalledWith("ssh", "\x02T");
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
    expect(mocks.write).not.toHaveBeenCalled();
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
    fireEvent.pointerDown(canvas, {pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100});
    fireEvent.pointerDown(canvas, {pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100});
    fireEvent.pointerMove(canvas, {pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100});
    fireEvent.pointerMove(canvas, {pointerId: 2, pointerType: "touch", clientX: 100, clientY: 100});
    fireEvent.pointerUp(canvas, {pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100});
    fireEvent.pointerUp(canvas, {pointerId: 2, pointerType: "touch", clientX: 100, clientY: 100});
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
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Next window"}));
    expect(mocks.write).toHaveBeenCalledWith("ssh", "\x02n");
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
    expect(mocks.write).not.toHaveBeenCalled();
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
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Find"}));
    fireEvent.change(screen.getByLabelText("Search terminal history"), {target: {value: "world"}});
    fireEvent.click(screen.getByRole("button", {name: "Next"}));
    expect(terminal.scrollToLine).toHaveBeenCalledWith(1);
    expect(screen.getByRole("status").textContent).toBe("Match on line 2");
  });
});
