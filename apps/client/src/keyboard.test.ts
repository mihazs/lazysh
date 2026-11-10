// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { agentViewShortcut, appShortcut, navigationShortcut, paletteShortcut, shiftedChordHint } from "./keyboard";
afterEach(() => {document.body.innerHTML = "";});
function shortcut(key: string, target: Element = document.body, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {key, ctrlKey: true, bubbles: true, cancelable: true, ...options});
  let result: ReturnType<typeof appShortcut>;
  target.addEventListener("keydown", e => {result = appShortcut(e as KeyboardEvent);}, {once: true});
  target.dispatchEvent(event);
  return result;
}
describe("hardware app shortcuts", () => {
  it("maps common app commands and numbered sessions", () => {
    expect(shortcut("K")).toEqual({action: "palette"});
    expect(shortcut("o")).toEqual({action: "switcher"});
    expect(shortcut("n")).toEqual({action: "newConnection"});
    expect(shortcut("w")).toEqual({action: "closeSession"});
    expect(shortcut("9", document.body, {ctrlKey: false, metaKey: true})).toEqual({action: "session", index: 8});
  });
  it("does not hijack editable controls, modal dialogs, composition or repeats", () => {
    for (const html of ['<input>', '<textarea></textarea>', '<select></select>', '<div contenteditable="true"></div>', '<div role="dialog"><button></button></div>']) {
      document.body.innerHTML = html;
      expect(shortcut("w", document.body.querySelector("button") ?? document.body.firstElementChild!)).toBeUndefined();
    }
    for (const options of [{isComposing: true}, {repeat: true}, {altKey: true}, {shiftKey: true}, {ctrlKey: false}]) expect(shortcut("n", document.body, options)).toBeUndefined();
    const event = new KeyboardEvent("keydown", {key: "w", ctrlKey: true, cancelable: true}); event.preventDefault();
    expect(appShortcut(event)).toBeUndefined();
  });
  it("allows session navigation from the actual terminal input without exempting regular textareas", () => {
    document.body.innerHTML = '<div class="terminal-canvas"><textarea class="xterm-helper-textarea"></textarea></div><textarea class="xterm-helper-textarea"></textarea>';
    const inputs = document.querySelectorAll("textarea");
    expect(shortcut("1", inputs[0])).toEqual({action: "session", index: 0});
    expect(shortcut("1", inputs[1])).toBeUndefined();
  });
  it("opens the palette with Ctrl/Cmd+Shift+P from the terminal input, but not from fields, dialogs or other chords", () => {
    document.body.innerHTML = '<div class="terminal-canvas"><textarea class="xterm-helper-textarea"></textarea></div><input><div role="dialog"><button></button></div>';
    const press = (target: Element, options: KeyboardEventInit) => {
      let result = false;
      target.addEventListener("keydown", e => {result = paletteShortcut(e as KeyboardEvent);}, {once: true});
      target.dispatchEvent(new KeyboardEvent("keydown", {key: "P", shiftKey: true, bubbles: true, cancelable: true, ...options}));
      return result;
    };
    const [terminal, input, dialog] = [document.querySelector("textarea")!, document.querySelector("input")!, document.querySelector("button")!];
    expect(press(terminal, {ctrlKey: true})).toBe(true);
    expect(press(document.body, {metaKey: true})).toBe(true);
    expect(press(input, {ctrlKey: true})).toBe(false);
    expect(press(dialog, {ctrlKey: true})).toBe(false);
    for (const options of [{ctrlKey: true, altKey: true}, {ctrlKey: true, shiftKey: false}, {ctrlKey: true, repeat: true}, {shiftKey: true}]) expect(press(document.body, options)).toBe(false);
    expect(shortcut("P", document.body, {shiftKey: true})).toBeUndefined();
  });
  it("toggles Agents and Workspaces with Ctrl/Cmd+Shift+A and W from the terminal input, never from fields, dialogs or the shell's own chords", () => {
    document.body.innerHTML = '<div class="terminal-canvas"><textarea class="xterm-helper-textarea"></textarea></div><input><div role="dialog"><button></button></div>';
    const press = (key: string, target: Element, options: KeyboardEventInit) => {
      let result: ReturnType<typeof navigationShortcut>;
      target.addEventListener("keydown", e => {result = navigationShortcut(e as KeyboardEvent, undefined, options.metaKey === true);}, {once: true});
      target.dispatchEvent(new KeyboardEvent("keydown", {key, shiftKey: true, bubbles: true, cancelable: true, ...options}));
      return result;
    };
    const [terminal, input, dialog] = [document.querySelector("textarea")!, document.querySelector("input")!, document.querySelector("button")!];
    expect(press("A", terminal, {ctrlKey: true})).toBe("agents");
    expect(press("W", terminal, {ctrlKey: true})).toBe("workspaces");
    expect(press("a", document.body, {metaKey: true})).toBe("agents");
    expect(press("A", input, {ctrlKey: true})).toBeUndefined();
    expect(press("W", dialog, {ctrlKey: true})).toBeUndefined();
    // Ctrl+A and Ctrl+W stay with the shell; other modifiers and repeats are ignored.
    for (const options of [{ctrlKey: true, shiftKey: false}, {ctrlKey: true, altKey: true}, {ctrlKey: true, repeat: true}, {ctrlKey: true, isComposing: true}, {}]) expect(press("A", terminal, options)).toBeUndefined();
    expect(press("P", terminal, {ctrlKey: true})).toBeUndefined();
    expect(shortcut("w", terminal)).toEqual({action: "closeSession"});
  });
  it("matches the Agent view toggle from the terminal and Agent draft, but not other editable controls", () => {
    document.body.innerHTML = '<div class="terminal-canvas"><textarea class="xterm-helper-textarea"></textarea></div><div class="agent-view"><div class="chat-draft"><textarea></textarea></div></div><input><div role="dialog"><button></button></div>';
    const press = (target: Element, options: KeyboardEventInit) => {
      let result = false;
      target.addEventListener('keydown', e => {result = agentViewShortcut(e as KeyboardEvent);}, {once: true});
      target.dispatchEvent(new KeyboardEvent('keydown', {key: 'Y', shiftKey: true, bubbles: true, ...options}));
      return result;
    };
    expect(press(document.querySelector('textarea')!, {ctrlKey: true})).toBe(true);
    expect(press(document.body, {metaKey: true})).toBe(true);
    expect(press(document.querySelector('.chat-draft textarea')!, {ctrlKey: true})).toBe(true);
    expect(press(document.querySelector('input')!, {ctrlKey: true})).toBe(false);
    expect(press(document.querySelector('button')!, {ctrlKey: true})).toBe(false);
    for (const options of [{ctrlKey: true, shiftKey: false}, {ctrlKey: true, repeat: true}, {ctrlKey: true, isComposing: true}, {ctrlKey: true, altKey: true}]) expect(press(document.body, options)).toBe(false);
  });
  it("labels Ctrl+Shift chords for the platform", () => {
    expect(shiftedChordHint("A", false)).toEqual({label: "Ctrl+Shift+A", keys: "Control+Shift+A"});
    expect(shiftedChordHint("W", true)).toEqual({label: "⌘⇧W", keys: "Meta+Shift+W"});
  });
});

it('matches configured navigation keys, rejects reserved keys, and exposes accessible hints', async () => {
  const {navigationBinding, parseNavigationBindings} = await import('./navigationBindings');
  const {navigationHint} = await import('./keyboard');
  expect(navigationBinding('Ctrl+Alt+Shift+F5')).toBe('C-M-S-F5');
  expect(parseNavigationBindings({agents:'M-comma',workspaces:null}).agents).toBe('M-comma');
  expect(navigationShortcut(new KeyboardEvent('keydown',{key:',',altKey:true}),{agents:'M-comma',workspaces:null})).toBe('agents');
  for (const value of ['C-S-P','C-S-Y','C-w','C-1','C-a C-b','text:hello','a','S-Tab','Enter']) expect(navigationBinding(value)).toBeUndefined();
  expect(parseNavigationBindings({agents:'C-S-B',workspaces:'C-S-B'})).toEqual({agents:'C-S-A',workspaces:'C-S-W'});
  const bindings = parseNavigationBindings({agents:'C-M-S-F5',workspaces:null});
  expect(navigationShortcut(new KeyboardEvent('keydown',{key:'F5',ctrlKey:true,altKey:true,shiftKey:true}),bindings)).toBe('agents');
  expect(navigationShortcut(new KeyboardEvent('keydown',{key:'W',ctrlKey:true,shiftKey:true}),bindings)).toBeUndefined();
  expect(navigationHint(bindings.agents,false)).toEqual({label:'Ctrl+Alt+Shift+F5',keys:'Control+Alt+Shift+F5'});
  expect(navigationHint(null)).toBeUndefined();
});


it('protects terminal typing, ordinary controls, platform modifiers, and AltGraph', async () => {
  const {navigationBinding} = await import('./navigationBindings');
  expect(navigationBinding('Tab')).toBeUndefined();
  expect(navigationBinding('S-a')).toBeUndefined();
  document.body.innerHTML = '<div class="terminal-canvas"><textarea class="xterm-helper-textarea"></textarea></div><input>';
  const terminal = document.querySelector('textarea')!, input = document.querySelector('input')!;
  const press = (target: Element, event: KeyboardEvent, apple: boolean) => {
    let result: ReturnType<typeof navigationShortcut>;
    target.addEventListener('keydown', e => {result = navigationShortcut(e as KeyboardEvent, undefined, apple);}, {once:true});
    target.dispatchEvent(event);
    return result;
  };
  const event = (options: KeyboardEventInit) => new KeyboardEvent('keydown',{key:'A',shiftKey:true,bubbles:true,...options});
  expect(press(terminal,event({ctrlKey:true}),false)).toBe('agents');
  expect(press(terminal,event({metaKey:true}),false)).toBeUndefined();
  expect(press(terminal,event({ctrlKey:true}),true)).toBeUndefined();
  expect(press(terminal,event({metaKey:true}),true)).toBe('agents');
  expect(press(terminal,event({ctrlKey:true,metaKey:true}),true)).toBeUndefined();
  expect(press(input,event({ctrlKey:true}),false)).toBeUndefined();
  const altGraph = event({ctrlKey:true});
  Object.defineProperty(altGraph,'getModifierState',{value:(key:string) => key === 'AltGraph'});
  expect(press(terminal,altGraph,false)).toBeUndefined();
});

it('matches resulting punctuation and Option-composed physical letters', () => {
  const plus = {agents:'M-+',workspaces:null};
  expect(navigationShortcut(new KeyboardEvent('keydown',{key:'+',code:'Equal',altKey:true,shiftKey:true}),plus,false)).toBe('agents');
  const letter = {agents:'M-A',workspaces:null};
  expect(navigationShortcut(new KeyboardEvent('keydown',{key:'å',code:'KeyA',altKey:true}),letter,true)).toBe('agents');
  const slash = {agents:'M-/',workspaces:null};
  expect(navigationShortcut(new KeyboardEvent('keydown',{key:'÷',code:'Slash',altKey:true}),slash,true)).toBe('agents');
  expect(navigationShortcut(new KeyboardEvent('keydown',{key:'⁄',code:'Digit1',altKey:true}),{agents:'M-1',workspaces:null},true)).toBe('agents');
  expect(navigationShortcut(new KeyboardEvent('keydown',{key:'±',code:'Equal',altKey:true,shiftKey:true}),plus,true)).toBe('agents');
});
