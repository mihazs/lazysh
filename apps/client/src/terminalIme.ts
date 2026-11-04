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
  let previous = area.value, start = previous.length;
  let composing = false, ending = false, hardware = false, sending = false, key229 = false;
  let keylessComposition: InputEvent | undefined;
  let generation = 0, deferred: KeyboardEvent | undefined, replaying = false;
  let keypressEvent: Event | undefined;
  let completion: ReturnType<typeof setTimeout> | undefined;
  let fallbackPending: {owner:number; delta:string} | undefined;
  const cancelComposition = () => {
    // xterm 5.5 has no public API to cancel a retained asynchronous IME commit.
    helper._isComposing = false; helper._isSendingComposition = false;
    helper._compositionView.classList.remove('active');
  };
  const reset = () => {
    generation++; clearTimeout(completion); deferred = undefined; fallbackPending = undefined;
    if (composing || ending) {cancelComposition(); area.value = '';}
    composing = false; ending = false; key229 = false; keylessComposition = undefined;
    previous = area.value; start = previous.length; hardware = false;
  };
  const foreground = () => acceptsInput() && document.hasFocus() && !document.hidden;
  const focused = () => foreground() && document.activeElement === area && !area.readOnly;
  const ownedDelta = (value: string) => {
    // InputConnection selection is independent of its composing range. The
    // native caret may remain inside a corrected word; our remote cursor stays
    // at the end of this owned suffix, so translate the text change from there.
    if (value.slice(0, start) !== previous.slice(0, start)) return;
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
    // Skip the unsafe edit and resynchronize the editor without pausing typing:
    // the terminal is unchanged and the next keyboard input is sent normally.
    area.value = ''; reset();
    onUnappliedEdit({text:value.slice(0, end),truncated:end !== value.length});
  };
  const dismiss = () => {onUnappliedEdit(null); resume();};
  // Blink can refocus a blurred editor when a retained native composition commits.
  const revoke = () => {area.value = ''; reset(); area.readOnly = true; area.blur();};
  const resume = () => {if (foreground()) area.readOnly = originalReadOnly;};
  const send = (value: string) => {
    if (!value) return;
    if (!focused()) {revoke(); return;}
    sending = true;
    try {terminal.input(value, true);} finally {sending = false;}
  };
  const commitFallback = () => {
    const pending = fallbackPending;
    if (!pending) return;
    fallbackPending = undefined; clearTimeout(completion);
    if (pending.owner !== generation || !focused()) return;
    // This edit already passed the owned-prefix and ASCII-erasure checks.
    send(pending.delta);
  };
  const output = terminal.onData(() => {
    if (userInput() && !sending && !composing && !ending) {
      const physical = hardware || !!keypressEvent?.eventPhase; reset(); hardware = physical;
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
    const value = composing || ending ? ownedDelta(area.value) : '';
    if (value === undefined) stage(area.value);
    else {reset(); send(value);}
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.target !== area || replaying) return;
    resume();
    if (!focused()) {event.stopImmediatePropagation(); revoke(); return;}
    keylessComposition = undefined;
    if (!composing && !ending) commitFallback();
    if (event.key === 'Process' && !event.code && event.keyCode === 0 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      hardware = false; event.stopImmediatePropagation(); return;
    }
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
      flush();
      hardware = true;
    }
  };
  const before = (event: InputEvent) => {
    if (event.target === area && !focused()) {event.preventDefault(); event.stopImmediatePropagation(); revoke(); return;}
    if (event.target === area) commitFallback();
    if (event.target === area && !composing && !ending && !hardware && previous !== area.value) {
      const blocked = key229; reset(); key229 = blocked;
    }
    if (event.target === area) {
      keylessComposition = !composing && !ending && !hardware && event.inputType === 'insertCompositionText' ? event : undefined;
      queueMicrotask(() => {if (keylessComposition === event) keylessComposition = undefined;});
    }
  };
  const input = (event: Event) => {
    if (!(event instanceof InputEvent)) return;
    if (event.target !== area) return;
    if (!focused()) {event.stopImmediatePropagation(); revoke(); return;}
    const keyless = keylessComposition && !keylessComposition.defaultPrevented; keylessComposition = undefined;
    if (composing || ending) {event.stopImmediatePropagation(); return;}
    commitFallback();
    if (hardware) {reset(); return;}
    const value = area.value;
    const fallback = (delta:string) => {
      const blocked = key229, ownedStart = start;
      reset();
      if (blocked) {
        start = ownedStart;
        event.stopImmediatePropagation();
        const owner = generation;
        fallbackPending = {owner,delta};
        completion = setTimeout(() => {if (generation === owner) commitFallback();}, 0);
      }
    };
    const delta = ownedDelta(value);
    if (delta === undefined) {event.stopImmediatePropagation(); stage(value); return;}
    if (event.inputType === 'insertLineBreak' && delta === '\n' && !key229) {
      event.stopImmediatePropagation(); previous = value; send('\r'); return;
    }
    if (!/^(insertText|insertReplacementText|deleteContentBackward)$/.test(event.inputType)
      && (event.inputType !== 'deleteContentForward' || key229)
      && (event.inputType !== 'insertCompositionText' || key229 || !keyless)) {fallback(delta); return;}
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
  const keypress = (event: Event) => {
    if (event.target !== area) return;
    if (!focused()) {event.preventDefault(); event.stopImmediatePropagation(); revoke(); return;}
    keypressEvent = event;
    if ((composing || ending) && event instanceof KeyboardEvent && (event.charCode || event.which || event.keyCode)) flush();
  };
  element.addEventListener('keypress', keypress, true);
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
  return {get idle() {return !composing && !ending && !sending && !replaying && !fallbackPending && !deferred && !key229 && !keylessComposition && !helper._isComposing && !helper._isSendingComposition;}, reset() {onUnappliedEdit(null); revoke();}, clear:reset, flush, resume, dismiss, dispose() {
    onUnappliedEdit(null); revoke(); output.dispose();
    element.removeEventListener('keypress', keypress, true);
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
