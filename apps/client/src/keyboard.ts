import {defaultNavigationBindings, type NavigationBindings, type NavigationShortcut} from "./navigationBindings";
import {useEffect, useRef} from "react";

export type AppShortcut = { action: "palette" | "switcher" | "newConnection" | "closeSession" } | { action: "session"; index: number };

/** App shortcuts never act inside modal dialogs or editable controls, except the terminal's own input. */
function appTarget(target: EventTarget | null, agentDraft = false): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest('[role="dialog"]')) return false;
  const terminalInput = target.matches('.xterm-helper-textarea') && target.closest('.terminal-canvas');
  return !!terminalInput || (agentDraft && target.matches('.chat-draft textarea') && !!target.closest('.agent-view')) || !target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
}

export function appShortcut(event: KeyboardEvent): AppShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (!appTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (/^[1-9]$/.test(key)) return {action: "session", index: Number(key) - 1};
  const actions = {k: "palette", o: "switcher", n: "newConnection", w: "closeSession"} as const;
  if (Object.hasOwn(actions, key)) return {action: actions[key as keyof typeof actions]};
}

/** The lowercased key of a Ctrl/Cmd+Shift chord the app may take, including from a focused terminal. */
function shiftedChord(event: KeyboardEvent, agentDraft = false): string | undefined {
  if (event.defaultPrevented || event.isComposing || event.repeat || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
  return appTarget(event.target, agentDraft) ? event.key.toLowerCase() : undefined;
}

/** Ctrl/Cmd+Shift+P opens the command palette, including from a focused terminal, whose shell keeps Ctrl/Cmd+K. */
export function paletteShortcut(event: KeyboardEvent): boolean {
  return shiftedChord(event) === 'p';
}

export type {NavigationShortcut} from './navigationBindings';

const optionKeys: Record<string, string> = {Backquote:'`~', Minus:'-_', Equal:'=+', BracketLeft:'[{', BracketRight:']}', Backslash:'\\|', Semicolon:';:', Quote:"'\"", Comma:',<', Period:'.>', Slash:'/?'};

/** Match saved navigation shortcuts without changing the terminal chord parser. */
export function navigationShortcut(event: KeyboardEvent, bindings: NavigationBindings = defaultNavigationBindings, apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): NavigationShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.getModifierState('AltGraph') || !appTarget(event.target)) return;
  if (apple ? event.ctrlKey : event.metaKey) return;
  const primary = apple ? event.metaKey : event.ctrlKey;
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
  const fallback = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : digit ? digit + ')!@#$%^&*('[Number(digit)] : optionKeys[event.code];
  const actualKey = event.altKey && !/^[\x20-\x7e]$/.test(event.key) && fallback ? fallback.length === 1 ? fallback : fallback[event.shiftKey ? 1 : 0] : event.key;
  const key = ({ArrowLeft:'Left', ArrowRight:'Right', ArrowUp:'Up', ArrowDown:'Down', ' ':'Space', ',':'comma'} as Record<string,string>)[actualKey] ?? (actualKey.length === 1 ? actualKey.toUpperCase() : actualKey);
  const implicitShift = /^[!-~]$/.test(actualKey) && !/^[a-z0-9]$/i.test(actualKey);
  const binding = `${primary ? 'C-' : ''}${event.altKey ? 'M-' : ''}${event.shiftKey && !implicitShift ? 'S-' : ''}${key}`;
  return (Object.keys(bindings) as NavigationShortcut[]).find(view => bindings[view] === binding);
}

export function navigationHint(binding: string | null, apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): ChordHint | undefined {
  if (!binding) return;
  const prefix = /^(?:(?:C|M|S)-)*/.exec(binding)![0];
  const parts = prefix.split('-').filter(Boolean);
  const key = binding.slice(prefix.length);
  const labels = parts.map(part => part === 'C' ? (apple ? '⌘' : 'Ctrl') : part === 'M' ? (apple ? '⌥' : 'Alt') : (apple ? '⇧' : 'Shift'));
  const aria = parts.map(part => part === 'C' ? (apple ? 'Meta' : 'Control') : part === 'M' ? 'Alt' : 'Shift');
  const name = ({Left:'ArrowLeft',Right:'ArrowRight',Up:'ArrowUp',Down:'ArrowDown',Space:'Space',comma:','} as Record<string,string>)[key] ?? key;
  return {label: [...labels,key === 'comma' ? ',' : key].join(apple ? '' : '+'), keys: [...aria,name].join('+')};
}

/** Ctrl/Cmd+Shift+Y toggles the session's Terminal and Agent views. */
export function agentViewShortcut(event: KeyboardEvent): boolean {
  return shiftedChord(event, true) === 'y';
}

/** A chord as shown to sighted users (`label`) and as `aria-keyshortcuts` announces it (`keys`). */
export type ChordHint = Readonly<{label: string; keys: string}>;
/** How a Ctrl/Cmd+Shift chord reads on this platform, as shown beside palette commands. */
export function shiftedChordHint(key: string, apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): ChordHint {
  return apple ? {label: `⌘⇧${key}`, keys: `Meta+Shift+${key}`} : {label: `Ctrl+Shift+${key}`, keys: `Control+Shift+${key}`};
}

/**
 * Runs `run` for chords `match` accepts, in the capture phase, before the terminal can consume them.
 * When `run` returns false it did not act, so the chord reaches the terminal as if unclaimed.
 */
export function useCapturedShortcut<T>(match: (event: KeyboardEvent) => T | undefined | false, run: (value: T) => boolean | void) {
  const latest = useRef({match, run}); latest.current = {match, run};
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const value = latest.current.match(event);
      if (value === undefined || value === false || latest.current.run(value) === false) return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, []);
}
