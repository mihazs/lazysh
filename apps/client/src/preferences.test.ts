// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { defaults, decodeClipboardRequest, parseChord, parsePreferences, parseTheme, terminalOptions } from "./preferences";

describe("terminal preferences trust boundary", () => {
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
  });
  it("rejects invalid and unbounded sequences and filters unsafe stored chords", () => {
    for (const sequence of ["", "Ctrl+Ctrl+c", "Meta+c", "Ctrl+1", "Shift+1", "__proto__", "toString", "F13", "a ".repeat(9), "\x1b"]) expect(() => parseChord(sequence)).toThrow();
    const p = parsePreferences({...defaults, chords: [{label: "next", keys: "Ctrl+b n"}, {label: "bad", keys: "Ctrl+wat"}], gestures: {left: "evil", right: "tab", up: "find"}});
    expect(p.chords).toEqual([{label: "next", keys: "Ctrl+b n"}]);
    expect(p.gestures).toEqual({left: "none", right: "tab", up: "find", down: "none"});
  });
});

describe("OSC52 clipboard requests", () => {
  it("decodes bounded UTF8 writes and never answers remote clipboard queries", () => {
    expect(decodeClipboardRequest("c;5L2g5aW9" )).toBe("你好");
    expect(decodeClipboardRequest("c;" )).toBe("");
    for (const input of ["c;?", "p;YWJj", "c;%%%", "c;/w==", "c;" + "A".repeat(90000), "missing-separator"]) expect(decodeClipboardRequest(input)).toBeUndefined();
  });
});
