import {useSyncExternalStore} from 'react';
import type {DialogAnswerer, TerminalControl} from './ChatTerminalInput';

/** The Agent view answers a dialog through the composer's bound input without either component holding the other's props:
 * the composer publishes its control, the view publishes whether the dialog may be answered (and re-checks the pane before each key),
 * and the conversation reads the combination. One entry per terminal session. A second guard, which only needs the pane to
 * still belong to the same reported session, lets the background-work panel send one message (a request to stop a task). */
export type TaskStopper = (text: string) => Promise<boolean>;
type Entry = {control?: TerminalControl; guard?: () => Promise<boolean>; answerer?: DialogAnswerer; taskGuard?: () => Promise<boolean>; stopper?: TaskStopper};
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function update(sessionId: string, change: Partial<Entry>) {
  const entry = {...entries.get(sessionId), ...change};
  const {control, guard, taskGuard} = entry;
  // A new answerer only when its inputs change, so subscribers do not re-render for nothing.
  entry.answerer = control?.ready && guard ? async answer => await guard() && control.answer(answer) : undefined;
  entry.stopper = control?.ready && taskGuard ? async text => await taskGuard() && control.answer({kind: 'send', text}) : undefined;
  entries.set(sessionId, entry);
  listeners.forEach(listener => listener());
}
export const publishComposerControl = (sessionId: string, control?: TerminalControl) => update(sessionId, {control});
export const publishAnswerGuard = (sessionId: string, guard?: () => Promise<boolean>) => update(sessionId, {guard});
/** The composer's bound input as it is now, for a surface that checks the dialog itself before and after each key. */
export const useComposerControl = (sessionId: string): TerminalControl | undefined => useSyncExternalStore(subscribe, () => entries.get(sessionId)?.control);
export const publishTaskGuard = (sessionId: string, taskGuard?: () => Promise<boolean>) => update(sessionId, {taskGuard});
const subscribe = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};
export const useDialogAnswerer = (sessionId: string): DialogAnswerer | undefined => useSyncExternalStore(subscribe, () => entries.get(sessionId)?.answerer);
export const useTaskStopper = (sessionId: string): TaskStopper | undefined => useSyncExternalStore(subscribe, () => entries.get(sessionId)?.stopper);
