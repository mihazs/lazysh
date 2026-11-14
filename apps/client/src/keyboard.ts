import {useEffect, useRef} from "react";
import {terminalEditorSelector} from "./terminalAdapter";
import {navigationShortcutKeys, navigationShortcutViews, type NavigationShortcut, type NavigationShortcutKeys} from "./navigationShortcuts";

export type AppShortcut = { action: "palette" | "switcher" | "newConnection" | "closeSession" } | { action: "session"; index: number };

/** App shortcuts never act inside modal dialogs or editable controls, except the terminal's own input. */
function appTarget(target: EventTarget | null, agentDraft = false): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest('[role="dialog"]')) return false;
  const terminalInput = target.matches(terminalEditorSelector) && target.closest('.terminal-canvas');
  return !!terminalInput || (agentDraft && target.matches('.chat-draft textarea, .agent-composer textarea') && !!target.closest('.agent-view')) || !target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
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

/** Ctrl/Cmd+Shift plus the saved key toggles Agents or Workspaces (A and W by default); the shell keeps the unshifted chords. */
export function navigationShortcut(event: KeyboardEvent, keys: NavigationShortcutKeys = navigationShortcutKeys()): NavigationShortcut | undefined {
  const key = shiftedChord(event);
  return key === undefined ? undefined : navigationShortcutViews.find(view => keys[view]?.toLowerCase() === key);
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

/** Ctrl/Cmd+Shift+L opens the Agent view's agent switcher, also from its composer. */
export function agentSwitchShortcut(event: KeyboardEvent): boolean {
  return shiftedChord(event, true) === 'l';
}
export const agentSwitchHint = () => shiftedChordHint('L');
