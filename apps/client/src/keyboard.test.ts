// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { appShortcut, navigationShortcut, paletteShortcut, shiftedChordLabel } from "./keyboard";
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
      target.addEventListener("keydown", e => {result = navigationShortcut(e as KeyboardEvent);}, {once: true});
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
  it("labels Ctrl+Shift chords for the platform", () => {
    expect(shiftedChordLabel("A", false)).toBe("Ctrl+Shift+A");
    expect(shiftedChordLabel("W", true)).toBe("⌘⇧W");
  });
});
