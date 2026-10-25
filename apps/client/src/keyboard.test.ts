// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { appShortcut } from "./keyboard";
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
});
