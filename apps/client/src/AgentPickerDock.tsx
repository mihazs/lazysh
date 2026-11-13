import {useEffect, useRef, useState} from 'react';
import {liftDialog, type Lift} from './agentDialogLift';
import {liftCodexDialog} from './agentCodexLift';
import {useComposerControl} from './agentDialogAnswer';
import {t} from './i18n/core';
import './AgentPickerDock.css';

/** The part of an xterm.js terminal the lift reads: the rows of the live screen and a signal that output was parsed. */
export type ScreenSource = Readonly<{
  rows: number;
  buffer: Readonly<{active: Readonly<{baseY: number; getLine: (y: number) => {translateToString: (trim?: boolean) => string} | undefined}>}>;
  onWriteParsed: (listener: () => void) => {dispose: () => void};
}>;
const none: Lift = {kind: 'none'};
type Lifter = typeof liftDialog;
const readLift = (terminal: ScreenSource, lifter: Lifter): Lift => {
  const {active} = terminal.buffer;
  return lifter(Array.from({length: terminal.rows}, (_, row) => active.getLine(active.baseY + row)?.translateToString(true) ?? ''));
};
const same = (a: Lift, b: Lift) => a.kind === b.kind && (a.kind !== 'dialog' || b.kind !== 'dialog' || JSON.stringify(a.dialog) === JSON.stringify(b.dialog));
const remembered = /don'?t ask again|never show again|\balways allow\b|\bfull access\b/i;
// Escape on a dialog whose footer says it interrupts stops the agent's turn, which is the Stop button's job and not a way to leave the dialog.
const interrupts = /\besc to interrupt\b/i;
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** The dialog the agent has open on the terminal screen, re-read about 150 ms after output while the view is shown. */
function useScreenLift(terminal: ScreenSource | undefined, active: boolean, lifter: Lifter): Lift {
  const [lift, setLift] = useState<Lift>(none);
  useEffect(() => {
    if (!terminal || !active) {setLift(none); return;}
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {timer = undefined; const next = readLift(terminal, lifter); setLift(previous => same(previous, next) ? previous : next);};
    read();
    const subscription = terminal.onWriteParsed(() => {timer ??= setTimeout(read, 150);});
    return () => {subscription.dispose(); clearTimeout(timer);};
  }, [terminal, active, lifter]);
  return lift;
}

type Phase = 'idle' | 'sending' | 'stale' | 'notMoved' | 'still' | 'failed';
const phaseNote = (phase: Exclude<Phase, 'idle' | 'sending'>) => ({stale: t('agentPickerStale'), notMoved: t('agentPickerNotMoved'), still: t('agentPickerStill'), failed: t('agentPickerFailed')})[phase];

/** The list dialog the agent has open (/model, the trust prompt, plan approval, a /resume or /rewind list), as large buttons. A choice
 * moves the highlight with arrow keys and presses Enter, as a person would, only after the screen is read again and is still this dialog.
 * A dialog it cannot read exactly, or one the composer is not bound to answer, says so and offers the terminal. */
export default function AgentPickerDock({sessionId, agent, shown, terminal, answerable, guard, waiting, onShowTerminal}: {
  sessionId: string; /** The agent whose dialogs are read: each agent draws its own. */ agent?: string; shown: boolean; terminal?: ScreenSource; answerable: boolean;
  /** Re-checks that the bound pane is still the one the agent's report names. */ guard: () => Promise<boolean>;
  /** A Claude Code approval and any question have their own card and need no banner here; Codex's approval has none. */
  waiting?: 'approval' | 'question' | 'plan' | 'menu' | 'unknown'; onShowTerminal: () => void;
}) {
  const lifter = agent === 'Codex' ? liftCodexDialog : liftDialog;
  const lift = useScreenLift(terminal, shown, lifter);
  const control = useComposerControl(sessionId);
  const dialog = lift.kind === 'dialog' ? lift.dialog : undefined;
  const [phase, setPhase] = useState<Phase>('idle');
  const [ready, setReady] = useState(false);
  const [confirming, setConfirming] = useState<number>();
  const signature = dialog?.signature;
  // A tap that landed as the card appeared, or as the dialog changed under the finger, must not answer.
  useEffect(() => {setReady(false); setPhase('idle'); setConfirming(undefined); if (!signature) return; const timer = setTimeout(() => setReady(true), 400); return () => clearTimeout(timer);}, [signature]);
  const live = !!control?.ready && !control.busy && answerable;
  const busy = !ready || phase === 'sending' || !live;
  const latest = useRef({dialog, terminal, control, lifter});
  latest.current = {dialog, terminal, control, lifter};

  /** Chooses one option, or cancels the dialog (no target), only while the screen still shows the dialog the person chose from. Moving the highlight
   * comes first and is read back: Enter is pressed only once the dialog shows the chosen option highlighted. */
  async function answer(target?: number) {
    const {dialog: before, terminal: screen, control: bound, lifter: read} = latest.current;
    if (!before || !screen || !bound?.ready || phase === 'sending') return;
    setPhase('sending');
    const onScreen = () => {const now = readLift(screen, read); return now.kind === 'dialog' && now.dialog.signature === before.signature && now.dialog.highlighted === before.highlighted;};
    // A list that scrolls as the highlight moves shows other rows, so the chosen option is found by what it says, not by its place.
    const chosen = target === undefined ? undefined : before.options[target];
    const twins = before.options.filter(option => option.label === chosen?.label && option.detail === chosen?.detail).length > 1;
    const highlightsChosen = () => {const now = readLift(screen, read); const row = now.kind === 'dialog' ? now.dialog.options[now.dialog.highlighted] : undefined;
      return now.kind === 'dialog' && now.dialog.title === before.title && row?.label === chosen?.label && row?.detail === chosen?.detail && (!twins || now.dialog.highlighted === target);};
    const settles = async (test: () => boolean) => {for (let attempt = 0; attempt < 20; attempt++) {await pause(150); if (test()) return true;} return false;};
    if (!onScreen() || !await guard()) {setPhase('stale'); return;}
    const rows = target === undefined ? 0 : target - before.highlighted;
    if (rows !== 0) {
      if (!await bound.answer({kind: 'pick', rows, enter: false})) {setPhase('failed'); return;}
      if (!await settles(highlightsChosen)) {setPhase('notMoved'); return;}
    }
    if (!await bound.answer(target === undefined ? {kind: 'request_stop'} : {kind: 'pick', rows: 0, enter: true})) {setPhase('failed'); return;}
    // The card is gone once the dialog closes; one that is still open says so.
    setPhase(await settles(() => !onScreen() && !highlightsChosen()) ? 'idle' : 'still');
  }
  // A choice that outlasts this answer (a rule, a session grant, a permission level) needs a second tap that names it; the agent's own digits are no way around it.
  const choose = (index: number) => remembered.test(dialog?.options[index].label ?? '') ? setConfirming(index) : void answer(index);
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

  if (dialog && confirming !== undefined) return <section className="agent-picker" aria-label={t('agentPickerTitle')}>
    <h4>{dialog.title}</h4>
    <p role="note">{t('agentPickerRemember', {choice: dialog.options[confirming].label})}</p>
    <div className="button-row">
      <button type="button" disabled={busy} onClick={() => {setConfirming(undefined); void answer(confirming);}}>{t('agentPickerConfirm')}</button>
      <button type="button" onClick={() => setConfirming(undefined)}>{t('agentPickerBack')}</button>
    </div>
  </section>;
  if (dialog) return <section className="agent-picker" aria-label={t('agentPickerTitle')} data-readonly={!live || undefined}>
    <h4>{dialog.title}</h4>
    {dialog.body.length > 0 && <div className="agent-picker-body">{dialog.body.map((line, index) => <p key={index}>{line}</p>)}</div>}
    <ol className="agent-picker-options">{dialog.options.map((option, index) => <li key={index}>
      {live ? <button type="button" disabled={busy} aria-current={index === dialog.highlighted || undefined} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.detail && <small>{option.detail}</small>}
      </button> : <p aria-current={index === dialog.highlighted || undefined}><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</p>}
    </li>)}</ol>
    {dialog.hint.length > 0 && <p className="agent-picker-hint">{dialog.hint.join(' ')}</p>}
    {!live && <p role="note">{t('agentPickerTerminalOnly')}</p>}
    {phase !== 'idle' && phase !== 'sending' && <p role="alert">{phaseNote(phase)}</p>}
    <div className="button-row">
      {live && !interrupts.test(dialog.hint.join(' ')) && <button type="button" disabled={busy} onClick={() => void answer()}>{t('agentPickerCancel')}</button>}
      <button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button>
    </div>
  </section>;
  // A dialog that cannot be read exactly, or a menu the agent reported that is not on screen: the terminal has it.
  if (shown && !(waiting === 'approval' && agent !== 'Codex') && waiting !== 'question' && (lift.kind === 'unliftable' || waiting === 'menu')) return <section className="agent-picker" aria-label={t('agentPickerTitle')}>
    <p role="status">{t('agentWaitingInTerminal')}</p>
    <div className="button-row"><button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button></div>
  </section>;
  return null;
}
