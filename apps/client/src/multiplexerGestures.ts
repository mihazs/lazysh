import type {MultiplexerKind} from './bridge';
import {parseChordSteps, type GestureAction, type GestureSlot} from './preferences';

/** Gesture actions that target the attached multiplexer's tab or pane level. */
export const multiplexerActions = ['nextTab', 'previousTab', 'nextPane', 'previousPane', 'zoomPane'] as const;
export type MultiplexerAction = typeof multiplexerActions[number];
export function isMultiplexerAction(action: GestureAction): action is MultiplexerAction {
  return (multiplexerActions as readonly string[]).includes(action);
}

const defaultPrefix = 'Ctrl+b';
/** rmux keeps tmux's prefix keys, so tmux and rmux terminals share one saved prefix and one binding table. */
export type PrefixKind = 'tmux' | 'rmux' | 'herdr';
const family = (kind: PrefixKind) => kind === 'herdr' ? 'herdr' : 'tmux';
const prefixKey = (kind: PrefixKind) => `lazysh.multiplexer.prefix.${family(kind)}`;
/** The prefix saved from the multiplexer shortcut panel, or Ctrl+b. */
export function storedPrefix(kind: PrefixKind): string {
  try { return localStorage.getItem(prefixKey(kind)) || defaultPrefix; } catch { return defaultPrefix; }
}
export function savePrefix(kind: PrefixKind, prefix: string) { localStorage.setItem(prefixKey(kind), prefix); }
/** A prefix is exactly one parsed key, never a literal or a multi-step chord. */
export function validPrefix(prefix: string): boolean {
  try { return !prefix.startsWith('text:') && !/\s/.test(prefix.trim()) && parseChordSteps(prefix).length === 1; }
  catch { return false; }
}
/** The prefix followed by one binding's steps, as one paced native sequence. */
export function prefixedSteps(prefix: string, ...steps: string[]): string[] {
  return [...parseChordSteps(prefix), ...steps.flatMap(step => parseChordSteps(step))];
}

/**
 * Default key bindings after the prefix. tmux has no default previous-pane key,
 * so that action types the equivalent command at tmux's command prompt. Herdr
 * focuses panes by direction; next and previous move right and left.
 */
const prefixBindings: Record<'tmux' | 'herdr', Record<MultiplexerAction, readonly string[]>> = {
  tmux: {nextTab: ['n'], previousTab: ['p'], nextPane: ['o'], previousPane: [':', 'text:select-pane -t :.-', 'Enter'], zoomPane: ['z']},
  herdr: {nextTab: ['n'], previousTab: ['p'], nextPane: ['l'], previousPane: ['h'], zoomPane: ['z']},
};
export function multiplexerSteps(kind: PrefixKind, action: MultiplexerAction, prefix = storedPrefix(kind)): string[] {
  return prefixedSteps(prefix, ...prefixBindings[family(kind)][action]);
}

/**
 * Level-aware defaults. In a multiplexer, horizontal two-finger swipes and a
 * short header pull move between tabs (tmux windows), vertical swipes between
 * panes and a pinch zooms the pane; a long header pull and, in a plain
 * terminal, horizontal swipes move between lazysh sessions. A plain terminal
 * has no panes, so its vertical swipes open Agents (up) and Workspaces (down).
 */
const levelDefaults: Record<'multiplexer' | 'plain', Partial<Record<GestureSlot, Exclude<GestureAction, 'auto'>>>> = {
  multiplexer: {twoLeft: 'nextTab', twoRight: 'previousTab', twoUp: 'nextPane', twoDown: 'previousPane', pinch: 'zoomPane', pullShallow: 'nextTab', pullDeep: 'nextSession'},
  plain: {twoLeft: 'nextSession', twoRight: 'previousSession', twoUp: 'openAgents', twoDown: 'openWorkspaces', pinch: 'fontSize', pullDeep: 'nextSession'},
};
/** A local terminal has no Agents, so a gesture bound to it stays inert there, matching its disabled toolbar key. */
export function resolveGesture(action: GestureAction, slot: GestureSlot | undefined, kind: MultiplexerKind | undefined, local = false): Exclude<GestureAction, 'auto'> {
  const resolved = action !== 'auto' ? action : (slot && levelDefaults[kind ? 'multiplexer' : 'plain'][slot]) || 'none';
  return local && resolved === 'openAgents' ? 'none' : resolved;
}
