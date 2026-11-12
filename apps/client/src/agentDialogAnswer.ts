import {useSyncExternalStore} from 'react';
import type {DialogAnswerer, TerminalControl} from './ChatTerminalInput';

/** The Agent view answers a dialog through the composer's bound input without either component holding the other's props:
 * the composer publishes its control, the view publishes whether the dialog may be answered (and re-checks the pane before each key),
 * and the conversation reads the combination. One entry per terminal session. */
type Entry = {control?: TerminalControl; guard?: () => Promise<boolean>; answerer?: DialogAnswerer};
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function update(sessionId: string, change: Partial<Entry>) {
  const entry = {...entries.get(sessionId), ...change};
  const {control, guard} = entry;
  // A new answerer only when its inputs change, so subscribers do not re-render for nothing.
  entry.answerer = control?.ready && guard ? async answer => await guard() && control.answer(answer) : undefined;
  entries.set(sessionId, entry);
  listeners.forEach(listener => listener());
}
export const publishComposerControl = (sessionId: string, control?: TerminalControl) => update(sessionId, {control});
export const publishAnswerGuard = (sessionId: string, guard?: () => Promise<boolean>) => update(sessionId, {guard});
export function useDialogAnswerer(sessionId: string): DialogAnswerer | undefined {
  return useSyncExternalStore(listener => {listeners.add(listener); return () => {listeners.delete(listener);};}, () => entries.get(sessionId)?.answerer);
}
