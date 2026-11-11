// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { defaults, decodeClipboardRequest, keepDevicePreferences, parseChord, parseChordSteps, parsePreferences, parseTheme, syncablePreferences, terminalOptions, toolbarFromRows, toolbarKeyHeights, toolbarKeys, toolbarRowBreak, toolbarRows } from "./preferences";

describe("terminal preferences trust boundary", () => {
  it('keeps past-bottom keyboard dismissal opt-in for old, invalid and stored settings',()=>{
    for(const value of [undefined,null,false,1,'true',{}])expect(parsePreferences({...defaults,dismissKeyboardOnOverscroll:value}).dismissKeyboardOnOverscroll).toBe(false);
    expect(defaults.dismissKeyboardOnOverscroll).toBe(false);
    expect(parsePreferences(JSON.parse(JSON.stringify({...defaults,dismissKeyboardOnOverscroll:true}))).dismissKeyboardOnOverscroll).toBe(true);
  });
  it('preserves Shift+Enter as a modified key instead of ordinary submission',()=>{
    expect(parseChord('Shift+Enter')).toBe('\x1b[13;2u');
    expect(parseChord('S-Enter')).toBe('\x1b[13;2u');
    expect(parseChord('Enter')).toBe('\r');
    expect(parseChord('Ctrl+Enter')).toBe('\r');
    expect(parseChord('Alt+Enter')).toBe('\x1b\r');
    expect(parseChord('Ctrl+Shift+Enter')).toBe('\r');
  });
  it('preserves keystroke boundaries and treats literal Unicode/spaces as one step',()=>{
    expect(parseChordSteps('C-b, S-t')).toEqual(['\x02','T']);
    expect(parseChordSteps('F12, M-h Enter')).toEqual(['\x1b[24~','\x1bh','\r']);
    expect(parseChordSteps('text: 你好,, 😀 ')).toEqual([' 你好,, 😀 ']);
    expect(parseChord('F12, M-h Enter')).toBe(parseChordSteps('F12, M-h Enter').join(''));
  });
  it('round-trips explicit Zellij gesture actions and defaults new two-finger, pinch and pull slots to level-aware actions', () => {
    const prefs=parsePreferences(JSON.parse(JSON.stringify({...defaults,
      bodyGestures:{...defaults.bodyGestures,swipeLeft:'nextZellijTab',swipeRight:'previousZellijTab'},
      gestures:{...defaults.gestures,left:'nextZellijPane',right:'previousZellijPane'},
    })));
    expect(prefs.bodyGestures.swipeLeft).toBe('nextZellijTab');
    expect(prefs.bodyGestures.swipeRight).toBe('previousZellijTab');
    expect(prefs.gestures.left).toBe('nextZellijPane');
    expect(prefs.gestures.right).toBe('previousZellijPane');
    expect(parsePreferences({version:1}).gestures).toEqual({left:'auto',right:'auto',up:'auto',down:'auto'});
    expect(parsePreferences({version:1}).bodyGestures).toEqual({tap:'none',doubleTap:'none',tripleTap:'none',swipeLeft:'none',swipeRight:'none',pinch:'auto',pullShallow:'auto',pullDeep:'auto'});
    // Explicit choices stored by earlier versions are kept, including "none".
    expect(parsePreferences({version:1,gestures:{left:'none',right:'none',up:'none',down:'none'}}).gestures).toEqual({left:'none',right:'none',up:'none',down:'none'});
  });
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
    expect(parsePreferences({...defaults, snippets: Array.from({length: 100}, () => ({label: "a", text: "b"}))}).snippets).toHaveLength(100);
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
    expect(p.gestures).toEqual({left: "auto", right: "tab", up: "find", down: "auto"});
  });
  it("keeps gesture chord content bound to a slot and drops malformed imported mappings", () => {
    const preferences = parsePreferences({...defaults, bodyGestures: {...defaults.bodyGestures, doubleTap: "custom", swipeLeft: "nextSession", tap: "unknown"}, gestureChords: {doubleTap: "C-b, T", twoLeft: "Contrl-x", unknown: "C-c"}});
    expect(preferences.bodyGestures).toMatchObject({doubleTap: "custom", swipeLeft: "nextSession", tap: "none"});
    expect(preferences.gestureChords).toEqual({doubleTap: "C-b, T"});
  });
  it("keeps level-aware and text-size actions to the slots that give them a meaning", () => {
    const preferences = parsePreferences({...defaults, bodyGestures: {...defaults.bodyGestures, tap: "auto", swipeLeft: "fontSize", pinch: "fontSize", pullShallow: "fontSize", pullDeep: "zoomPane"}, gestures: {...defaults.gestures, up: "fontSize"}, dpadCorners: {left: "auto", right: "zoomPane"}});
    expect(preferences.bodyGestures).toMatchObject({tap: "none", swipeLeft: "none", pinch: "fontSize", pullShallow: "auto", pullDeep: "zoomPane"});
    expect(preferences.gestures.up).toBe("auto");
    expect(preferences.dpadCorners).toEqual({left: "interrupt", right: "zoomPane"});
  });
  it("stores toolbar long-press actions only for non-modifier keys with known actions and valid chords", () => {
    const stored = JSON.parse(JSON.stringify(parsePreferences({...defaults, toolbarAlternates: {
      esc: {action: "zoomPane"}, "-": {action: "custom", keys: "text:_"}, tab: {action: "custom", keys: "Contrl-x"},
      ctrl: {action: "paste"}, c: {action: "auto"}, d: {action: "none"}, enter: "paste", unknown: {action: "paste"},
    }})));
    expect(stored.toolbarAlternates).toEqual({esc: {action: "zoomPane"}, "-": {action: "custom", keys: "text:_"}, tab: {action: "custom"}});
    // Without long-press actions the snapshot carries no new field, so older sync peers still accept it.
    expect(Object.hasOwn(JSON.parse(JSON.stringify(parsePreferences({...defaults, toolbarAlternates: {ctrl: {action: "paste"}}}))), "toolbarAlternates")).toBe(false);
  });
  it("keeps Agents and Workspaces as toolbar keys and as actions for every discrete slot", () => {
    const stored = JSON.parse(JSON.stringify(parsePreferences({...defaults, toolbar: ["esc", "agents", "workspaces"],
      bodyGestures: {...defaults.bodyGestures, doubleTap: "openAgents", pullShallow: "openWorkspaces"}, gestures: {...defaults.gestures, up: "openWorkspaces"},
      dpadCorners: {left: "openAgents", right: "backspace"}, toolbarAlternates: {esc: {action: "openWorkspaces"}}})));
    expect(stored).toMatchObject({toolbar: ["esc", "agents", "workspaces"], bodyGestures: {doubleTap: "openAgents", pullShallow: "openWorkspaces"},
      gestures: {up: "openWorkspaces"}, dpadCorners: {left: "openAgents"}, toolbarAlternates: {esc: {action: "openWorkspaces"}}});
    // Neither key is a default toolbar key, so existing toolbars keep their layout.
    expect(defaults.toolbar).not.toContain("agents");
    expect(defaults.toolbar).not.toContain("workspaces");
  });
});

describe("OSC52 clipboard requests", () => {
  it("decodes bounded UTF8 writes and never answers remote clipboard queries", () => {
    expect(decodeClipboardRequest("c;5L2g5aW9" )).toBe("你好");
    expect(decodeClipboardRequest("c;" )).toBe("");
    for (const input of ["c;?", "p;YWJj", "c;%%%", "c;/w==", "c;" + "A".repeat(90000), "missing-separator"]) expect(decodeClipboardRequest(input)).toBeUndefined();
  });
});

 it("keeps flat toolbars as one row and validates stored row breaks", () => {
  expect(toolbarRows(parsePreferences({...defaults, toolbar: ["esc", "tab"]}).toolbar)).toEqual([["esc", "tab"]]);
  // Two rows of nine once the terminal adds its More key to the second, so the arrows sit under Home, Up and End.
  expect(toolbarRows(defaults.toolbar)).toEqual([["keyboard", "attach", "esc", "tab", "paste", "/", "Home", "up", "End"], ["shift", "ctrl", "meta", "c", "d", "left", "down", "right"]]);
  const stored = parsePreferences(JSON.parse(JSON.stringify({...defaults, toolbar: toolbarFromRows([["esc", "ctrl"], [], ["left", "right"]])})));
  expect(toolbarRows(stored.toolbar)).toEqual([["esc", "ctrl"], [], ["left", "right"]]);
  // Duplicates across rows, unknown entries and breaks beyond the third row are dropped without losing keys.
  const hostile = parsePreferences({...defaults, toolbar: ["esc", toolbarRowBreak, "esc", "run", "tab", toolbarRowBreak, "c", toolbarRowBreak, "d", toolbarRowBreak]});
  expect(hostile.toolbar).toEqual(["esc", toolbarRowBreak, "tab", toolbarRowBreak, "c", "d"]);
  expect(toolbarRows(hostile.toolbar)).toEqual([["esc"], ["tab"], ["c", "d"]]);
 });
 it("keeps the toolbar key height within its bounds and stores it only when it differs from the default", () => {
  const stored = (toolbarKeyHeight: unknown) => parsePreferences({...defaults, toolbarKeyHeight}).toolbarKeyHeight;
  expect(Object.hasOwn(parsePreferences({...defaults}), "toolbarKeyHeight")).toBe(false);
  expect(Object.hasOwn(JSON.parse(JSON.stringify(parsePreferences({...defaults, toolbarKeyHeight: toolbarKeyHeights.default}))), "toolbarKeyHeight")).toBe(false);
  for (const height of [toolbarKeyHeights.min, 44, toolbarKeyHeights.max]) expect(stored(height)).toBe(height);
  // Anything else (out of range, fractional, not a number) falls back to the default, which is not stored.
  for (const height of [toolbarKeyHeights.min - 1, toolbarKeyHeights.max + 1, 0, -40, 40.5, NaN, "44", null, [], {}]) expect(stored(height)).toBeUndefined();
  expect(stored(44)).toBe(parsePreferences(JSON.parse(JSON.stringify({...defaults, toolbarKeyHeight: 44}))).toolbarKeyHeight);
 });
 it("keeps the toolbar key height on this device when settings sync", () => {
  const mine = parsePreferences({...defaults, toolbarKeyHeight: 44, snippets: [{label: "a", text: "b"}]});
  // Uploading leaves the height out, so a peer that predates it still accepts the snapshot.
  const uploaded = syncablePreferences(mine);
  expect(Object.hasOwn(uploaded, "toolbarKeyHeight")).toBe(false);
  expect(uploaded.snippets).toEqual(mine.snippets);
  // A download from a device with another height, or none, keeps this device's.
  expect(parsePreferences(keepDevicePreferences({...defaults, toolbarKeyHeight: 56, fontSize: 20}, mine))).toMatchObject({toolbarKeyHeight: 44, fontSize: 20});
  expect(parsePreferences(keepDevicePreferences({...defaults, fontSize: 20}, parsePreferences({...defaults}))).toolbarKeyHeight).toBeUndefined();
  expect(keepDevicePreferences(null, mine)).toBeNull();
 });
 it("lets a client without row support read the same keys from a multi-row toolbar", () => {
  const multiRow = toolbarFromRows([["esc", "ctrl"], ["tab"]]);
  // The previous release's validator: keep known keys only, in order.
  const previous = [...new Set(multiRow.filter(item => (toolbarKeys as readonly string[]).includes(item)))];
  expect(previous).toEqual(["esc", "ctrl", "tab"]);
 });
 it("upgrades only the previous default toolbars and preserves explicit customization", () => {
  expect(parsePreferences({...defaults, toolbar:["esc","ctrl","tab","c","d","paste","left","up","down","right"]}).toolbar).toEqual(defaults.toolbar);
  // The one-row default of the previous release, as saved with any other preference change.
  expect(parsePreferences({...defaults, toolbar:["esc","ctrl","meta","shift","tab","paste","attach","left","up","down","right","c","d"]}).toolbar).toEqual(defaults.toolbar);
  // The same keys in another order, or with one removed, are the user's own layout and keep every key.
  for (const toolbar of [["esc","ctrl","meta","shift","tab","paste","attach","left","up","down","right","d","c"], ["esc","ctrl","meta","shift","tab","paste","attach","left","up","down","right","c"]]) expect(parsePreferences({...defaults,toolbar}).toolbar).toEqual(toolbar);
  for (const toolbar of [[], ["meta","F12","attach","shift"]]) expect(parsePreferences({...defaults,toolbar}).toolbar).toEqual(toolbar);
 });
