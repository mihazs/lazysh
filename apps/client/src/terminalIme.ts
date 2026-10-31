import type {Terminal} from '@xterm/xterm';
import {version} from '@xterm/xterm/package.json';

export type UnappliedTerminalEdit = {text: string; truncated: boolean};

/** Keep the editable IME suffix separate from terminal control input. */
export function observeTerminalIme(terminal: Terminal, userInput: () => boolean, acceptsInput: () => boolean, onUnappliedEdit: (edit: UnappliedTerminalEdit | null) => void = () => {}) {
  const area = terminal.textarea, element = terminal.element;
  if (!area || !element || version !== '5.5.0') return;
  const helper = (terminal as unknown as {_core?: {_compositionHelper?: {
    _isComposing: boolean; _isSendingComposition: boolean; _compositionView: HTMLElement;
  }}})._core?._compositionHelper;
  if (!helper || typeof helper._isComposing !== 'boolean' || typeof helper._isSendingComposition !== 'boolean'
    || !(helper._compositionView instanceof HTMLElement)) return;
  const originalReadOnly = area.readOnly;
  let unapplied: UnappliedTerminalEdit | null = null;
  let previous = area.value, start = previous.length;
  let composing = false, ending = false, hardware = false, sending = false, key229 = false;
  let generation = 0, deferred: KeyboardEvent | undefined, replaying = false;
  let completion: ReturnType<typeof setTimeout> | undefined;
  let fallbackPending: {owner:number; previous:string; value:string} | undefined;
  const cancelComposition = () => {
    // xterm 5.5 has no public API to cancel a retained asynchronous IME commit.
    helper._isComposing = false; helper._isSendingComposition = false;
    helper._compositionView.classList.remove('active');
  };
  const reset = () => {
    generation++; clearTimeout(completion); deferred = undefined; fallbackPending = undefined;
    if (composing || ending) {cancelComposition(); area.value = '';}
    composing = false; ending = false; key229 = false;
    previous = area.value; start = previous.length; hardware = false;
  };
  const foreground = () => acceptsInput() && document.hasFocus() && !document.hidden;
  const focused = () => foreground() && document.activeElement === area && !area.readOnly;
  const ownedDelta = (value: string) => {
    // Blink can report caret 0 for a fresh keyless insertion after refocus. With
    // an empty baseline there is no sent span to erase or replay.
    if (value.slice(0, start) !== previous.slice(0, start)
      || (previous.length > 0 && (area.selectionStart !== value.length || area.selectionEnd !== value.length))) return;
    const old = Array.from(previous.slice(start)), next = Array.from(value.slice(start));
    let common = 0;
    while (common < old.length && old[common] === next[common]) common++;
    // The peer owns erase units; never guess rollback for committed Unicode.
    if (old.slice(common).some(character => !/^[ -~]$/.test(character))) return;
    return '\x7f'.repeat(old.length - common) + next.slice(common).join('');
  };
  const stage = (value: string) => {
    // This is local IME context, not an editable remote command line. Never log or persist it.
    let end = Math.min(value.length, 65536);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    unapplied = {text:value.slice(0, end),truncated:end !== value.length};
    area.value = ''; reset(); area.readOnly = true;
    onUnappliedEdit(unapplied);
  };
  const dismiss = () => {revoke(); unapplied = null; onUnappliedEdit(null); resume();};
  // Blink can refocus a blurred editor when a retained native composition commits.
  const revoke = () => {area.value = ''; reset(); area.readOnly = true; area.blur();};
  const resume = () => {if (!unapplied && foreground()) area.readOnly = originalReadOnly;};
  const send = (value: string) => {
    if (!value || unapplied) return;
    if (!focused()) {revoke(); return;}
    sending = true;
    try {terminal.input(value, true);} finally {sending = false;}
  };
  const commitFallback = () => {
    const pending = fallbackPending;
    if (!pending) return;
    fallbackPending = undefined; clearTimeout(completion);
    if (pending.owner !== generation || !focused()) return;
    const old = pending.previous, value = pending.value;
    // Match xterm 5.5 CompositionHelper._handleAnyTextareaChanges, with an owned timer.
    send(value.length > old.length ? value.replace(old, '') : value.length < old.length ? '\x7f' : value !== old ? value : '');
  };
  const output = terminal.onData(() => {
    if (userInput() && !sending && !composing && !ending) {
      const physical = hardware; reset(); hardware = physical;
    }
  });
  const replay = (event: KeyboardEvent) => {
    replaying = true;
    try {area.dispatchEvent(new KeyboardEvent('keydown', {
      key:event.key, code:event.code, keyCode:event.keyCode, ctrlKey:event.ctrlKey,
      altKey:event.altKey, metaKey:event.metaKey, shiftKey:event.shiftKey,
      bubbles:true, composed:true, cancelable:true,
    }));} finally {replaying = false;}
  };
  const finish = () => {
    if (!focused()) {revoke(); return;}
    const value = ownedDelta(area.value), key = deferred;
    if (value === undefined) {stage(area.value); return;}
    cancelComposition(); clearTimeout(completion);
    composing = false; ending = false; deferred = undefined; previous = area.value;
    send(value);
    if (key) {if (focused()) replay(key); reset();}
  };
  const flush = () => {
    commitFallback();
    if (unapplied) return false;
    const value = composing || ending ? ownedDelta(area.value) : '';
    if (value === undefined) {stage(area.value); return false;}
    reset(); send(value);
    return !unapplied;
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.target !== area || replaying) return;
    resume();
    if (!focused()) {event.stopImmediatePropagation(); revoke(); return;}
    if (!composing && !ending) commitFallback();
    if (event.keyCode === 229) {
      hardware = false;
      // xterm's key229 timeout treats an equal-length correction as another word.
      if (!composing && !ending) key229 = true;
      event.stopImmediatePropagation();
      return;
    }
    if ((composing || ending) && event.key === 'Enter') {
      deferred ??= event;
      event.preventDefault(); event.stopImmediatePropagation();
      return;
    }
    if (!['Shift','Control','Alt','Meta'].includes(event.key)) {
      if (!flush()) {event.preventDefault(); event.stopImmediatePropagation(); return;}
      hardware = true;
    }
  };
  const before = (event: InputEvent) => {
    if (event.target === area && !focused()) {event.preventDefault(); event.stopImmediatePropagation(); revoke(); return;}
    if (event.target === area) commitFallback();
    if (event.target === area && !composing && !ending && !hardware && previous !== area.value) {
      const blocked = key229; reset(); key229 = blocked;
    }
  };
  const input = (event: Event) => {
    if (!(event instanceof InputEvent)) return;
    if (event.target !== area) return;
    if (!focused()) {event.stopImmediatePropagation(); revoke(); return;}
    if (composing || ending) {event.stopImmediatePropagation(); return;}
    commitFallback();
    if (hardware) {reset(); return;}
    const value = area.value;
    const fallback = () => {
      const blocked = key229, old = previous;
      reset();
      if (blocked) {
        event.stopImmediatePropagation();
        const owner = generation;
        fallbackPending = {owner,previous:old,value};
        completion = setTimeout(() => {if (generation === owner) commitFallback();}, 0);
      }
    };
    const delta = ownedDelta(value);
    if (delta === undefined) {event.stopImmediatePropagation(); stage(value); return;}
    if (!/^(insertText|insertReplacementText|deleteContentBackward)$/.test(event.inputType)) {fallback(); return;}
    event.stopImmediatePropagation(); key229 = false; previous = value;
    send(delta);
  };
  const begin = (event: CompositionEvent) => {
    if (event.target !== area) return;
    if (!focused()) {event.stopImmediatePropagation(); revoke(); return;}
    commitFallback();
    if (ending) finish();
    const ownedStart = area.value === previous ? start : area.value.length;
    reset(); start = ownedStart; composing = true;
  };
  const end = (event: CompositionEvent) => {
    if (event.target !== area) return;
    event.stopImmediatePropagation();
    if (!focused()) {revoke(); return;}
    if (!composing) return;
    composing = false; ending = true; cancelComposition();
    const owner = generation;
    // Read the final DOM value after native compositionend propagation, once per owner.
    completion = setTimeout(() => {if (generation === owner) finish();}, 0);
  };
  const boundary = (event: Event) => {if (event.target === area) revoke();};
  const paste = (event: Event) => {if (event.target === area) flush();};
  const activate = () => {commitFallback(); resume();};
  const keyup = () => {hardware = false;};
  element.addEventListener('keydown', keydown, true);
  element.addEventListener('keyup', keyup, true);
  element.addEventListener('beforeinput', before, true);
  element.addEventListener('input', input, true);
  element.addEventListener('compositionstart', begin, true);
  element.addEventListener('compositionend', end, true);
  element.addEventListener('blur', boundary, true);
  element.addEventListener('paste', paste, true);
  element.addEventListener('pointerdown', activate, true);
  element.addEventListener('click', activate, true);
  return {get blocked() {return !!unapplied;}, reset() {unapplied = null; onUnappliedEdit(null); revoke();}, clear:reset, flush, resume, dismiss, dispose() {
    unapplied = null; onUnappliedEdit(null); revoke(); output.dispose();
    element.removeEventListener('keydown', keydown, true);
    element.removeEventListener('keyup', keyup, true);
    element.removeEventListener('beforeinput', before, true);
    element.removeEventListener('input', input, true);
    element.removeEventListener('compositionstart', begin, true);
    element.removeEventListener('compositionend', end, true);
    element.removeEventListener('blur', boundary, true);
    element.removeEventListener('paste', paste, true);
    element.removeEventListener('pointerdown', activate, true);
    element.removeEventListener('click', activate, true);
    area.readOnly = originalReadOnly;
  }};
}
