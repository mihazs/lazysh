import { useSyncExternalStore } from "react";
import type { ITheme, ITerminalOptions } from "@xterm/xterm";

export const themes = {
  forest: { background: "#101311", foreground: "#d9e0d6", cursor: "#c4eb89", selectionBackground: "#40543a", black: "#1d231f", red: "#f48781", green: "#b9df83", yellow: "#e4ce8b", blue: "#8caee4", magenta: "#c4a1dd", cyan: "#8ccfc1", white: "#d9e0d6", brightBlack: "#788478", brightRed: "#ffb0a6", brightGreen: "#d0f0a6", brightYellow: "#f3e0ac", brightBlue: "#b1caf0", brightMagenta: "#dfc3ef", brightCyan: "#b0e8de", brightWhite: "#f3f5ee" },
  midnight: { background: "#101622", foreground: "#dee6f3", cursor: "#9fc6ff", selectionBackground: "#354763" },
  paper: { background: "#faf8f2", foreground: "#242822", cursor: "#375c29", selectionBackground: "#cbdac0" },
} satisfies Record<string, ITheme>;
export const toolbarKeys = ["esc", "ctrl", "meta", "tab", "c", "d", "enter", "backspace", "paste", "dpad", "left", "up", "down", "right"] as const;
export type ToolbarKey = typeof toolbarKeys[number];
export const gestureActions = ["none", "left", "right", "pageUp", "pageDown", "escape", "tab", "find", "compose", "paste", "keyboard", "hideKeyboard", "copy", "backspace", "interrupt", "nextSession", "previousSession", "custom"] as const;
export const gestureDirections = ["left", "right", "up", "down"] as const;
export const bodyGestureSlots = ["tap", "doubleTap", "tripleTap", "swipeLeft", "swipeRight"] as const;
export const gestureSlots = [...bodyGestureSlots, "twoLeft", "twoRight", "twoUp", "twoDown", "cornerLeft", "cornerRight"] as const;
export type GestureSlot = typeof gestureSlots[number];
export const gestureLabels: Record<GestureAction, string> = {none: "No action", left: "Arrow left", right: "Arrow right", pageUp: "Page up", pageDown: "Page down", escape: "Escape", tab: "Tab", find: "Find in history", compose: "Compose text", paste: "Paste clipboard", keyboard: "Show keyboard", hideKeyboard: "Hide keyboard", copy: "Copy selection", backspace: "Backspace", interrupt: "Interrupt (Ctrl+C)", nextSession: "Next lazysh session", previousSession: "Previous lazysh session", custom: "Custom key chord"};
export type GestureAction = typeof gestureActions[number];
export type Preferences = {
  version: 1;
  theme: keyof typeof themes;
  appTheme: keyof typeof themes;
  sessionLayout: "list" | "cards";
  customTheme?: ITheme;
  fontSize: number;
  fontFamily: string;
  cjkFallback: string;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  optionAsMeta: boolean;
  screenReader: boolean;
  toolbar: ToolbarKey[];
  snippets: { label: string; text: string }[];
  chords: { label: string; keys: string }[];
  pinchZoom: boolean;
  gestures: Record<typeof gestureDirections[number], GestureAction>;
  bodyGestures: Record<typeof bodyGestureSlots[number], GestureAction>;
  gestureChords: Partial<Record<GestureSlot, string>>;
  dpadCorners: {left: GestureAction; right: GestureAction};
  autoHideToolbar: boolean;
};
export const defaults: Preferences = {
  version: 1, theme: "forest", appTheme: "forest", sessionLayout: "list", fontSize: 14,
  fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  cjkFallback: "'Noto Sans Mono CJK SC', 'PingFang SC', 'Microsoft YaHei', monospace",
  cursorStyle: "bar", cursorBlink: true, scrollback: 5000,
  optionAsMeta: false, screenReader: false,
  toolbar: ["esc", "ctrl", "tab", "c", "d", "paste", "left", "up", "down", "right"], snippets: [],
  chords: [], pinchZoom: true, gestures: {left: "none", right: "none", up: "none", down: "none"}, autoHideToolbar: false,
  bodyGestures: {tap: "none", doubleTap: "none", tripleTap: "none", swipeLeft: "none", swipeRight: "none"}, gestureChords: {}, dpadCorners: {left: "interrupt", right: "backspace"},
};
const key = "lazysh.preferences.v1";
const event = "lazysh-preferences";

export function parseTheme(value: unknown): ITheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A theme must be a JSON object of hexadecimal colors.");
  const result: Record<string, string> = {};
  const allowed = new Set([...Object.keys(themes.forest), "selectionForeground", "cursorAccent", "selectionInactiveBackground"]);
  for (const [name, color] of Object.entries(value)) {
    if (!allowed.has(name) || typeof color !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) throw new Error(`Invalid theme color: ${name}`);
    result[name] = color;
  }
  if (!result.background || !result.foreground) throw new Error("Theme needs background and foreground colors.");
  return result;
}

export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults };
  const p = value as Record<string, unknown>;
  if (p.version !== 1) return { ...defaults };
  const number = (name: string, min: number, max: number, fallback: number) => typeof p[name] === "number" && Number.isInteger(p[name]) && p[name] >= min && p[name] <= max ? p[name] as number : fallback;
  let customTheme: ITheme | undefined;
  const gestureChords: Partial<Record<GestureSlot, string>> = {};
  if (p.gestureChords && typeof p.gestureChords === "object") {
    for (const slot of gestureSlots) {
      const keys = (p.gestureChords as Record<string, unknown>)[slot];
      try {if (typeof keys === "string") {parseChord(keys); gestureChords[slot] = keys;}} catch { /* Invalid imported chords never become gesture input. */ }
    }
  }
  const action = (source: unknown, slot: string, fallback: GestureAction): GestureAction => {
    const value = source && typeof source === "object" ? (source as Record<string, unknown>)[slot] : undefined;
    return gestureActions.includes(value as GestureAction) ? value as GestureAction : fallback;
  };
  try { if (p.customTheme) customTheme = parseTheme(p.customTheme); } catch { /* Invalid stored themes fall back to a bundled theme. */ }
  return {
    version: 1,
    sessionLayout: p.sessionLayout === "cards" ? "cards" : "list",
    theme: typeof p.theme === "string" && Object.hasOwn(themes, p.theme) ? p.theme as Preferences["theme"] : defaults.theme,
    appTheme: typeof p.appTheme === "string" && Object.hasOwn(themes, p.appTheme) ? p.appTheme as Preferences["appTheme"] : defaults.appTheme,
    ...(customTheme ? { customTheme } : {}),
    fontSize: number("fontSize", 10, 32, defaults.fontSize),
    fontFamily: typeof p.fontFamily === "string" && p.fontFamily.length > 0 && p.fontFamily.length <= 256 && !/[;{}\x00-\x1f]/.test(p.fontFamily) ? p.fontFamily : defaults.fontFamily,
    cjkFallback: typeof p.cjkFallback === "string" && p.cjkFallback.length > 0 && p.cjkFallback.length <= 256 && !/[;{}\x00-\x1f]/.test(p.cjkFallback) ? p.cjkFallback : defaults.cjkFallback,
    cursorStyle: p.cursorStyle === "bar" || p.cursorStyle === "block" || p.cursorStyle === "underline" ? p.cursorStyle : defaults.cursorStyle,
    cursorBlink: typeof p.cursorBlink === "boolean" ? p.cursorBlink : defaults.cursorBlink,
    scrollback: number("scrollback", 100, 20000, defaults.scrollback),
    optionAsMeta: p.optionAsMeta === true,
    screenReader: p.screenReader === true,
    autoHideToolbar: p.autoHideToolbar === true,
    pinchZoom: p.pinchZoom !== false,
    bodyGestures: Object.fromEntries(bodyGestureSlots.map(slot => [slot, action(p.bodyGestures, slot, defaults.bodyGestures[slot])])) as Preferences["bodyGestures"],
    gestureChords,
    dpadCorners: {left: action(p.dpadCorners, "left", "interrupt"), right: action(p.dpadCorners, "right", "backspace")},
    gestures: Object.fromEntries(gestureDirections.map(direction => {
      const action = p.gestures && typeof p.gestures === "object" ? (p.gestures as Record<string, unknown>)[direction] : undefined;
      return [direction, gestureActions.includes(action as GestureAction) ? action : defaults.gestures[direction]];
    })) as Preferences["gestures"],
    chords: Array.isArray(p.chords) ? p.chords.filter((chord): chord is {label: string; keys: string} => {
      if (!chord || typeof chord !== "object" || typeof chord.label !== "string" || chord.label.length < 1 || chord.label.length > 32 || typeof chord.keys !== "string") return false;
      try { parseChord(chord.keys); return true; } catch { return false; }
    }).slice(0, 12).map(({label, keys}) => ({label, keys})) : [],
    toolbar: Array.isArray(p.toolbar) ? [...new Set(p.toolbar.filter((item): item is ToolbarKey => toolbarKeys.includes(item as ToolbarKey)))].slice(0, toolbarKeys.length) : [...defaults.toolbar],
    snippets: Array.isArray(p.snippets) ? p.snippets.filter((s): s is {label: string; text: string} => !!s && typeof s === "object" && typeof s.label === "string" && s.label.length > 0 && s.label.length <= 32 && typeof s.text === "string" && s.text.length > 0 && s.text.length <= 2048 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s.text)).slice(0, 12).map(({label, text}) => ({label, text})) : [],
  };
}
let cached: Preferences | undefined;
export function getPreferences(): Preferences {
  if (!cached) {
    try { cached = parsePreferences(JSON.parse(localStorage.getItem(key) ?? "null")); }
    catch { cached = { ...defaults }; }
  }
  return cached;
}
export function savePreferences(value: Preferences) {
  const validated = parsePreferences(value);
  localStorage.setItem(key, JSON.stringify(validated));
  cached = validated;
  window.dispatchEvent(new Event(event));
}
function subscribe(listener: () => void) {
  const stored = (e: StorageEvent) => { if (e.key === key || e.key === null) { cached = undefined; listener(); } };
  window.addEventListener(event, listener);
  window.addEventListener("storage", stored);
  return () => { window.removeEventListener(event, listener); window.removeEventListener("storage", stored); };
}
export function usePreferences() { return useSyncExternalStore(subscribe, getPreferences, () => defaults); }
export function terminalOptions(p: Preferences, fontFamily = `${p.fontFamily}, ${p.cjkFallback}`): ITerminalOptions {
  return { fontSize: p.fontSize, fontFamily, cursorStyle: p.cursorStyle, cursorBlink: p.cursorBlink, scrollback: p.scrollback, macOptionIsMeta: p.optionAsMeta, screenReaderMode: p.screenReader, theme: p.customTheme ?? themes[p.theme] };
}

export function decodeClipboardRequest(data: string): string | undefined {
  const separator = data.indexOf(";");
  if (separator < 0 || !/^[cs]*$/.test(data.slice(0, separator))) return;
  const encoded = data.slice(separator + 1);
  // Clipboard queries are never answered; only bounded writes can be offered for consent.
  if (encoded === "?" || encoded.length > 87384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return;
  try {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    if (bytes.length > 65536) return;
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch { return; }
}

export function parseChord(source: string): string {
  if (!source.trim() || source.length > 128) throw new Error("Enter up to 8 key steps, for example Ctrl+b n.");
  if (source.startsWith("text:")) {
    const text = source.slice(5);
    if (!text || /[\x00-\x1f\x7f]/.test(text)) throw new Error("Literal shortcuts need printable text; add an Enter key separately when needed.");
    return text;
  }
  if (/^\s*,|,\s*$|,\s*,/.test(source)) throw new Error("Every chord step needs a key; use text: for a literal comma.");
  const steps = source.trim().split(/[\s,]+/);
  if (steps.length > 8) throw new Error("A chord can contain at most 8 steps.");
  return steps.map(step => {
    let remainder = step;
    const modifiers: string[] = [];
    for (;;) {
      const prefix = /^(Ctrl|Control|Alt|Opt|Option|Shift|C|M|S)[+-]/i.exec(remainder);
      if (!prefix) break;
      modifiers.push(/^(c|ctrl|control)$/i.test(prefix[1]) ? "ctrl" : /^(s|shift)$/i.test(prefix[1]) ? "shift" : "alt");
      remainder = remainder.slice(prefix[0].length);
    }
    const aliases: Record<string, string> = {Esc: "Escape", BSpace: "Backspace", dash: "-", plus: "+", comma: ","};
    const key = Object.hasOwn(aliases, remainder) ? aliases[remainder] : remainder;
    if (new Set(modifiers).size !== modifiers.length || modifiers.some(modifier => !["ctrl", "alt", "shift"].includes(modifier))) throw new Error(`Invalid modifiers in ${step}`);
    const ctrl = modifiers.includes("ctrl"), alt = modifiers.includes("alt"), shift = modifiers.includes("shift");
    const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    const arrows: Record<string, string> = {Left: "D", Right: "C", Up: "A", Down: "B", Home: "H", End: "F"};
    if (Object.hasOwn(arrows, key)) return modifier === 1 ? `\x1b[${arrows[key]}` : `\x1b[1;${modifier}${arrows[key]}`;
    const tilde: Record<string, number> = {Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24};
    if (Object.hasOwn(tilde, key)) return `\x1b[${tilde[key]}${modifier === 1 ? "" : `;${modifier}`}~`;
    if (/^F[1-4]$/.test(key)) {
      const code = "PQRS"[Number(key.slice(1)) - 1];
      return modifier === 1 ? `\x1bO${code}` : `\x1b[1;${modifier}${code}`;
    }
    const named: Record<string, string> = {Enter: "\r", Escape: "\x1b", Tab: "\t", Backspace: "\x7f", Space: " "};
    const isNamed = Object.hasOwn(named, key);
    let value = isNamed ? named[key] : key;
    if (!isNamed && (key.length !== 1 || !/^[!-~]$/.test(key))) throw new Error(`Unknown key: ${key}`);
    if (shift && key === "Tab") return alt ? "\x1b\x1b[Z" : "\x1b[Z";
    if (shift && /^[a-z]$/i.test(value)) value = value.toUpperCase();
    else if (shift && !isNamed) throw new Error(`Use the resulting character instead of Shift+${key}`);
    if (ctrl) {
      if (key === "Backspace") value = "\b";
      else if (key === "-") value = "\x1f";
      else if (value === " " || value === "@") value = "\x00";
      else if (/^[a-z\[\\\]\^_]$/i.test(value)) value = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31);
      else if (value === "?") value = "\x7f";
      else if (!isNamed) throw new Error(`Ctrl is unsupported for ${key}`);
    }
    return alt ? `\x1b${value}` : value;
  }).join("");
}
