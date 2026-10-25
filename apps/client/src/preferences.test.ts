// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { defaults, decodeClipboardRequest, parseChord, parsePreferences, parseTheme, terminalOptions } from "./preferences";

describe("terminal preferences trust boundary", () => {
  it('uses the extended light palette only for Paper or explicit light metadata', () => {
    const colors = {background:'#ffffff',foreground:'#111111',red:'#123456',brightRed:'#abcdef'};
    const legacy = parsePreferences({...defaults, customTheme:colors});
    const light = parsePreferences({...legacy, customThemeInfo:{name:'Light',mode:'light'}});
    const dark = parsePreferences({...light, customThemeInfo:{name:'Dark',mode:'dark'}});
    for (const p of [light, {...defaults,theme:'paper' as const}]) expect(terminalOptions(p).theme?.extendedAnsi).toHaveLength(240);
    for (const p of [defaults,legacy,dark]) expect(terminalOptions(p).theme?.extendedAnsi).toBeUndefined();
    expect(terminalOptions(light).theme).toMatchObject(colors);
    expect(terminalOptions(light).theme?.extendedAnsi).not.toBe(terminalOptions(light).theme?.extendedAnsi);
  });
  it("preserves the list default for old or invalid stored layouts", () => {
    for (const sessionLayout of [undefined, null, "grid", "__proto__", [], {cards: true}]) {
      expect(parsePreferences({...defaults, sessionLayout}).sessionLayout).toBe("list");
    }
    expect(parsePreferences({...defaults, sessionLayout: "cards"}).sessionLayout).toBe("cards");
  });
  it("rejects oversized settings, unknown actions and invalid colors", () => {
    const p = parsePreferences({...defaults, fontSize: Infinity, scrollback: 1e9, fontFamily: "monospace;url(evil)", cursorStyle: "invalid", toolbar: ["paste", "run-command", "paste", "esc"], customTheme: {background: "url(evil)", foreground: "#ffffff"}, snippets: [{label: "unsafe", text: "\x1b[31m"}, {label: "project", text: "cd project"}]});
    expect(p.fontSize).toBe(14);
    expect(p.scrollback).toBe(5000);
    expect(p.fontFamily).toBe(defaults.fontFamily);
    expect(p.toolbar).toEqual(["paste", "esc"]);
    expect(p.customTheme).toBeUndefined();
    expect(p.snippets).toEqual([{label: "project", text: "cd project"}]);
    expect(() => parseTheme({background: "#ffffff", foreground: "#101010", surprise: "#000000"})).toThrow();
    expect(() => parseTheme({background: "#ffffff"})).toThrow();
    expect(parsePreferences({...defaults, version: 2})).toEqual(defaults);
  });
  it("applies bounded settings and custom colors to xterm", () => {
    const p = parsePreferences({...defaults, fontSize: 24, scrollback: 20000, optionAsMeta: true, screenReader: true, customTheme: {background: "#ffffff", foreground: "#101010"}});
    expect(terminalOptions(p)).toMatchObject({fontSize: 24, scrollback: 20000, macOptionIsMeta: true, screenReaderMode: true, theme: {background: "#ffffff", foreground: "#101010"}});
    expect(parsePreferences({...defaults, snippets: Array.from({length: 100}, () => ({label: "a", text: "b"}))}).snippets).toHaveLength(12);
  });
});

describe("keyboard chords", () => {
  it("encodes modifiers per step, arrows and function keys", () => {
    expect(parseChord("Ctrl+b n")).toBe("\x02n");
    expect(parseChord("Ctrl+Alt+c Shift+Tab F12 Ctrl+Left")).toBe("\x1b\x03\x1b[Z\x1b[24~\x1b[1;5D");
    expect(parseChord("Space Ctrl+Space Shift+a F1")).toBe(" \x00A\x1bOP");
    expect(parseChord("C-b, S-t")).toBe("\x02T");
    expect(parseChord("M-x Opt+y Esc BSpace dash plus")).toBe("\x1bx\x1by\x1b\x7f-+");
    expect(parseChord("C-dash")).toBe("\x1f");
    expect(parseChord("text:/clear, keep spaces ")).toBe("/clear, keep spaces ");
  });
  it("rejects invalid and unbounded sequences and filters unsafe stored chords", () => {
    for (const sequence of ["", "Ctrl+Ctrl+c", "Meta+c", "Ctrl+1", "Shift+1", "__proto__", "toString", "F13", "a ".repeat(9), "\x1b", "Contrl-b", "C-b,,T", "text:\x1b", "text:"]) expect(() => parseChord(sequence)).toThrow();
    const p = parsePreferences({...defaults, chords: [{label: "next", keys: "Ctrl+b n"}, {label: "bad", keys: "Ctrl+wat"}], gestures: {left: "evil", right: "tab", up: "find"}});
    expect(p.chords).toEqual([{label: "next", keys: "Ctrl+b n"}]);
    expect(p.gestures).toEqual({left: "none", right: "tab", up: "find", down: "none"});
  });
  it("keeps gesture chord content bound to a slot and drops malformed imported mappings", () => {
    const preferences = parsePreferences({...defaults, bodyGestures: {...defaults.bodyGestures, doubleTap: "custom", swipeLeft: "nextSession", tap: "unknown"}, gestureChords: {doubleTap: "C-b, T", twoLeft: "Contrl-x", unknown: "C-c"}});
    expect(preferences.bodyGestures).toMatchObject({doubleTap: "custom", swipeLeft: "nextSession", tap: "none"});
    expect(preferences.gestureChords).toEqual({doubleTap: "C-b, T"});
  });
});

describe("OSC52 clipboard requests", () => {
  it("decodes bounded UTF8 writes and never answers remote clipboard queries", () => {
    expect(decodeClipboardRequest("c;5L2g5aW9" )).toBe("你好");
    expect(decodeClipboardRequest("c;" )).toBe("");
    for (const input of ["c;?", "p;YWJj", "c;%%%", "c;/w==", "c;" + "A".repeat(90000), "missing-separator"]) expect(decodeClipboardRequest(input)).toBeUndefined();
  });
});
