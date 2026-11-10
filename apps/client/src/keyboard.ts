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

export type NavigationShortcut = 'agents' | 'workspaces';
/** The letter each Ctrl/Cmd+Shift navigation chord uses. */
export const navigationShortcutKeys = {agents: 'A', workspaces: 'W'} as const satisfies Record<NavigationShortcut, string>;

/** Ctrl/Cmd+Shift+A toggles Agents and Ctrl/Cmd+Shift+W toggles Workspaces; the shell keeps the unshifted chords. */
export function navigationShortcut(event: KeyboardEvent): NavigationShortcut | undefined {
  const key = shiftedChord(event);
  return (Object.keys(navigationShortcutKeys) as NavigationShortcut[]).find(view => navigationShortcutKeys[view].toLowerCase() === key);
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
