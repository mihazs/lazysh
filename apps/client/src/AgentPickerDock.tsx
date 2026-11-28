import {useEffect, useRef, useState} from 'react';
import {liftDialog, none, type Lift} from './agentDialogLift';
import {liftCodexDialog} from './agentDialogLiftCodex';
import {dialogCopy} from './agentDialogScreen';
import {publishDialogOpen, useComposerControl} from './agentDialogAnswer';
import {t} from './i18n/core';
import type {TerminalAdapter} from './terminalAdapter';
import './AgentPickerDock.css';

/** What the lift reads from the session's terminal: the text of the live screen's rows and a signal that output was parsed. */
export type ScreenSource = Pick<TerminalAdapter, 'readRows' | 'viewport' | 'subscribe'> & {
  /** A screen read from the host instead of a live terminal buffer: read it again before deciding from it. */
  readAgain?: () => Promise<void>;
};
/** The agents whose dialogs were captured from a real session (`src/test/agentDialogs`): each reads its own screen, and no other agent's dialog is guessed. */
const lifters: Readonly<Record<string, (screen: readonly string[]) => Lift>> = {'Claude Code': liftDialog, Codex: liftCodexDialog};
export const hasDialogProfile = (agent: string | undefined) => agent !== undefined && agent in lifters;
const readLift = (terminal: ScreenSource, agent: string): Lift => {
  // A backend that cannot inspect rows shows no dialog here; the terminal still has it.
  if (!terminal.readRows) return none;
  const {length, rows} = terminal.viewport();
  // The live screen is the last `rows` rows of the buffer.
  return lifters[agent]?.(terminal.readRows(length - rows, rows)) ?? none;
};
const same = (a: Lift, b: Lift) => a.kind === b.kind && (a.kind !== 'dialog' || b.kind !== 'dialog' || JSON.stringify(a.dialog) === JSON.stringify(b.dialog));
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** The dialog the agent has open on the terminal screen, re-read about 150 ms after output while the view is shown. */
function useScreenLift(terminal: ScreenSource | undefined, active: boolean, agent: string): {lift: Lift; rows: readonly string[]} {
  const [state, setState] = useState<{lift: Lift; rows: readonly string[]}>({lift: none, rows: []});
  useEffect(() => {
    if (!terminal || !active) {setState({lift: none, rows: []}); return;}
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {timer = undefined; const lift = readLift(terminal, agent); const {length, rows} = terminal.viewport();
      const screen = lift.kind === 'unliftable' ? terminal.readRows?.(length - rows, rows) ?? [] : [];
      setState(previous => same(previous.lift, lift) && JSON.stringify(previous.rows) === JSON.stringify(screen) ? previous : {lift, rows: screen});};
    read();
    const subscription = terminal.subscribe(() => {timer ??= setTimeout(read, 150);}, ['output']);
    return () => {subscription.dispose(); clearTimeout(timer);};
  }, [terminal, active, agent]);
  return state;
}

/** Display only a recognized question's current screen, without inferring how to answer it. */
function questionScreen(agent: string, rows: readonly string[]): string {
  const lastIndex = (items: readonly string[], matches: (row: string) => boolean) => {
    for (let index = items.length - 1; index >= 0; index--) if (matches(items[index])) return index;
    return -1;
  };
  const last = lastIndex(rows, row => agent === 'Codex' ? /tab or esc to clear notes/i.test(row) : /Enter to select.*Esc to cancel/.test(row));
  if (last < 0) return '';
  const before = rows.slice(0, last);
  if (agent !== 'Codex' && (agent !== 'Claude Code' || !before.some(row => /Type something|Chat about this/.test(row)))) return '';
  const first = agent === 'Codex' ? lastIndex(before, row => /^\s*Question \d+\/\d+/.test(row)) : (() => {
    const rules = before.flatMap((row, index) => /^\s*─{8,}\s*$/.test(row) ? [index] : []);
    return rules.length >= 2 ? rules[rules.length - 2] : -1;
  })();
  return first < 0 ? '' : rows.slice(first, last + 1).join('\n').trim();
}

type Phase = 'idle' | 'sending' | 'stale' | 'notMoved' | 'still' | 'failed';
const phaseNote = (phase: Exclude<Phase, 'idle' | 'sending'>) => ({stale: t('agentPickerStale'), notMoved: t('agentPickerNotMoved'), still: t('agentPickerStill'), failed: t('agentPickerFailed')})[phase];

/** The list dialog the agent has open (/model, the trust prompt, plan approval, a /resume or /rewind list), as large buttons. A choice
 * moves the highlight with arrow keys and presses Enter, as a person would, only after the screen is read again and is still this dialog.
 * A dialog it cannot read exactly, or one the composer is not bound to answer, says so and offers the terminal. */
export default function AgentPickerDock({sessionId, shown, terminal, agent = 'Claude Code', answerable, guard, waiting, onShowTerminal}: {
  sessionId: string; shown: boolean; terminal?: ScreenSource; answerable: boolean;
  /** The agent running in the pane, whose dialogs the screen is read for. */ agent?: string;
  /** Re-checks that the bound pane is still the one the agent's report names. */ guard: () => Promise<boolean>;
  /** The type of interaction reported by the agent, when available. */
  waiting?: 'approval' | 'question' | 'plan' | 'menu' | 'unknown'; onShowTerminal: () => void;
}) {
  const {lift, rows: screenRows} = useScreenLift(terminal, shown, agent);
  // A Claude approval has its own card. Question cards can be absent or read-only,
  // so an unliftable live question must still offer a path to the terminal.
  const ownCard = waiting === 'approval' && agent === 'Claude Code';
  const control = useComposerControl(sessionId);
  const dialog = lift.kind === 'dialog' ? lift.dialog : undefined;
  const open = shown && lift.kind !== 'none';
  useEffect(() => {publishDialogOpen(sessionId, open); return () => publishDialogOpen(sessionId, false);}, [sessionId, open]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [readySignature, setReadySignature] = useState<string>();
  const answerSequence = useRef(0);
  const signature = dialog?.signature;
  // A tap that landed as the card appeared, or as the dialog changed under the finger, must not answer.
  useEffect(() => {answerSequence.current++; setReadySignature(undefined); setPhase('idle'); if (!signature) return; const timer = setTimeout(() => setReadySignature(signature), 400); return () => clearTimeout(timer);}, [signature, terminal, guard, sessionId]);
  const live = !!control?.ready && !control.busy && answerable;
  const busy = !signature || readySignature !== signature || phase === 'sending' || !live;
  const latest = useRef({dialog, terminal, control, guard, sessionId});
  latest.current = {dialog, terminal, control, guard, sessionId};

  /** Chooses one option, or cancels the dialog (no target), only while the screen still shows the dialog the person chose from. Moving the highlight
   * comes first and is read back: Enter is pressed only once the dialog shows the chosen option highlighted. Each key carries the rows of the dialog
   * as just read, and the host reads the pane again right before pressing it: a pane that no longer shows exactly that dialog gets nothing. */
  async function answer(target?: number) {
    const {dialog: before, terminal: screen, control: bound} = latest.current;
    if (!before || !screen || !bound?.ready || phase === 'sending') return;
    const sequence = ++answerSequence.current;
    const current = () => answerSequence.current === sequence && latest.current.terminal === screen && latest.current.guard === guard && latest.current.sessionId === sessionId && latest.current.dialog?.signature === before.signature;
    const finish = (next: Phase) => {if (current()) setPhase(next);};
    setPhase('sending');
    const dialogNow = () => {const now = readLift(screen, agent); return now.kind === 'dialog' && now.dialog.signature === before.signature && now.dialog.highlighted === before.highlighted ? now.dialog : undefined;};
    const onScreen = () => !!dialogNow();
    // A list that scrolls as the highlight moves shows other rows, so the chosen option is found by what it says, not by its place.
    const chosen = target === undefined ? undefined : before.options[target];
    const twins = before.options.filter(option => option.label === chosen?.label && option.detail === chosen?.detail).length > 1;
    // The dialog as the screen was read at the tap, and later as read back with the chosen option highlighted: what each key is sent to.
    await screen.readAgain?.();
    let tapped = dialogNow();
    let confirmed = tapped ?? before;
    const highlightsChosen = () => {const now = readLift(screen, agent); const row = now.kind === 'dialog' ? now.dialog.options[now.dialog.highlighted] : undefined;
      const same = now.kind === 'dialog' && now.dialog.title === before.title && row?.label === chosen?.label && row?.detail === chosen?.detail && (!twins || now.dialog.highlighted === target);
      if (same) confirmed = now.dialog;
      return same;};
    const settles = async (test: () => boolean) => {for (let attempt = 0; attempt < 20; attempt++) {await pause(150); await screen.readAgain?.(); if (test()) return true;} return false;};
    // A key the host refused (the pane shows something else by now) changed nothing: say so if this screen has moved on too.
    const refused = () => finish(onScreen() ? 'failed' : 'stale');
    if (!tapped || !await guard()) {finish('stale'); return;}
    tapped = dialogNow();
    if (!current() || latest.current.control !== bound || !tapped) {finish('stale'); return;}
    confirmed = tapped;
    const rows = target === undefined ? 0 : target - before.highlighted;
    if (rows !== 0) {
      if (!await bound.answer({kind: 'pick', rows, enter: false, seen: tapped.rows})) {refused(); return;}
      if (!await settles(highlightsChosen)) {finish('notMoved'); return;}
    }
    if (!await bound.answer(target === undefined ? {kind: 'dismiss', seen: confirmed.rows} : {kind: 'pick', rows: 0, enter: true, seen: confirmed.rows})) {refused(); return;}
    // The card is gone once the dialog closes; one that is still open says so.
    finish(await settles(() => !onScreen() && !highlightsChosen()) ? 'idle' : 'still');
  }
  const [confirm, setConfirm] = useState<number>();
  useEffect(() => setConfirm(undefined), [signature]);
  // An option that keeps a permission rule is never one tap: it first shows what it keeps.
  const choose = (index: number) => {if (dialog?.options[index]?.remember && confirm !== index) setConfirm(index); else {setConfirm(undefined); void answer(index);}};
  // On a desktop keyboard the digits pick the options of the open dialog, as they do in the terminal.
  useEffect(() => {
    if (!dialog || busy) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const index = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
      if (index >= 0 && index < dialog.options.length) {event.preventDefault(); choose(index);}
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  if (dialog) return <section className="agent-picker" aria-label={t('agentPickerTitle')} data-readonly={!live || undefined}>
    <h4>{dialog.title}</h4>
    {dialog.body.length > 0 && <div className="agent-picker-body">{dialog.body.map((line, index) => <p key={index}>{line}</p>)}</div>}
    <ol className="agent-picker-options">{dialog.options.map((option, index) => <li key={index}>
      {live ? <button type="button" disabled={busy} aria-current={index === dialog.highlighted || undefined} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.detail && <small>{option.detail}</small>}
      </button> : <p aria-current={index === dialog.highlighted || undefined}><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</p>}
    </li>)}</ol>
    {confirm !== undefined && dialog.options[confirm] && <section className="agent-picker-confirm" aria-label={t('agentPickerRememberTitle')}>
      <p>{t('agentPickerRemember')}</p>
      <p><code>{dialog.options[confirm].label}</code></p>
      <div className="button-row">
        <button type="button" onClick={() => setConfirm(undefined)}>{t('agentPickerRememberCancel')}</button>
        <button type="button" disabled={busy} onClick={() => choose(confirm)}>{t('agentPickerRememberApply')}</button>
      </div>
    </section>}
    {dialog.hint.length > 0 && <p className="agent-picker-hint">{dialog.hint.join(' ')}</p>}
    {!live && <p role="note">{t('agentPickerTerminalOnly')}</p>}
    {phase !== 'idle' && phase !== 'sending' && <p role="alert">{phaseNote(phase)}</p>}
    <div className="button-row">
      {live && !dialog.interrupts && <button type="button" disabled={busy} onClick={() => void answer()}>{t('agentPickerCancel')}</button>}
      <button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button>
    </div>
  </section>;
  // A dialog that cannot be read exactly, a menu the agent reported that is not on screen, or an approval or plan decision of an
  // agent whose dialogs were never captured (Grok Build, Gemini CLI, OpenCode): the terminal has it.
  const unreadable = !hasDialogProfile(agent) && (waiting === 'approval' || waiting === 'plan');
  // A question is shown as it is drawn; any other dialog the profile cannot read exactly shows its own rows, read-only.
  const question = questionScreen(agent, screenRows) || dialogCopy(agent, screenRows);
  if (shown && !ownCard && (lift.kind === 'unliftable' || waiting === 'menu' || unreadable)) return <section className="agent-picker" aria-label={t('agentPickerTitle')}>
    {question && <pre className="agent-picker-screen">{question}</pre>}
    <p role="status">{t('agentWaitingInTerminal')}</p>
    <div className="button-row"><button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button></div>
  </section>;
  return null;
}
