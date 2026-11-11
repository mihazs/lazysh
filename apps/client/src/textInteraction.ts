import {useEffect, useRef} from 'react';

/**
 * The guard behind every edge gesture: true while the user types or edits text, or while a
 * competing touch gesture is in flight. Components push what only they know (a terminal
 * selection); everything observable on the document (typing, composition, focus, selection,
 * pinch, scrolling) is read here, so no gesture reimplements it.
 */
export type TextInteractionKind = 'typing' | 'composition' | 'selection' | 'selectionHandle' | 'cursorDrag' | 'pinch' | 'scroll' | 'field';

export const typingWindowMs = 800;
const pinchSettleMs = 200, scrollSettleMs = 350, scrollEventMs = 150, flingWindowMs = 1500, compositionStaleMs = 30_000, dragSlop = 10;
/** Input types that do not take typed text. */
const nonTextInputs = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

export const clock = () => performance.now();

type Probe = () => boolean;
const probes = new Map<object, {kind: TextInteractionKind; probe: Probe}>();
/** Registers state only its owner can read (a terminal selection); polled whenever a gesture asks. Returns the release. */
export function registerTextInteraction(kind: TextInteractionKind, probe: Probe): () => void {
  const owner = {};
  probes.set(owner, {kind, probe});
  return () => void probes.delete(owner);
}
/** Marks a kind active for one owner until it reports false; owners never mask each other. */
export function reportTextInteraction(kind: TextInteractionKind, active: boolean, owner: object) {
  if (active) probes.set(owner, {kind, probe: () => true}); else probes.delete(owner);
}
export function useTextInteraction(kind: TextInteractionKind, active: boolean) {
  const owner = useRef({}).current;
  useEffect(() => {
    reportTextInteraction(kind, active, owner);
    return () => reportTextInteraction(kind, false, owner);
  }, [kind, active, owner]);
}
/** Counts a key sent from outside the document's key events, such as a toolbar key. */
export function markTyping() { typedAt = clock(); }

// Observed document state.
let typedAt = -Infinity, composing = false, composedAt = 0;
let touching = 0, sawMultiTouch = false, pinchUntil = -Infinity, scrollUntil = -Infinity, flingUntil = -Infinity;
let origin: {x: number; y: number} | null = null, owned = false, dragging = false;

/** A touch an edge recogniser owns is a swipe, not the competing scroll the guard watches for. */
export function markTouchOwned(value = true) { owned = value; if (value) dragging = false; }

function observeKeys(event: Event) {
  markTyping();
  if ((event as KeyboardEvent | InputEvent).isComposing) {composing = true; composedAt = clock();}
}
function observeComposition(event: Event) {
  composing = event.type !== 'compositionend';
  composedAt = clock();
  if (!composing) markTyping();
}
function observeTouch(event: Event) {
  const touches = (event as TouchEvent).touches, now = clock();
  // The engine's own synthetic cancel carries no touch list and says nothing about the fingers.
  if (!touches) return;
  if (event.type === 'touchstart') {
    if (touches.length <= 1) {sawMultiTouch = false; owned = false; dragging = false; origin = touches[0] ? {x: touches[0].clientX, y: touches[0].clientY} : null;}
    touching = touches.length;
    if (touches.length >= 2) sawMultiTouch = true;
    return;
  }
  touching = touches.length;
  if (event.type === 'touchmove') {
    const point = touches[0];
    if (touches.length === 1 && origin && point && !owned && Math.hypot(point.clientX - origin.x, point.clientY - origin.y) > dragSlop) dragging = true;
    return;
  }
  // touchend or touchcancel: a finished drag leaves its fling, and a pinch its last finger.
  if (sawMultiTouch) pinchUntil = now + pinchSettleMs;
  if (touching === 0) {
    if (dragging && !owned && !sawMultiTouch) {scrollUntil = now + scrollSettleMs; flingUntil = now + flingWindowMs;}
    dragging = false;
  }
}
function observeScroll() {
  // Output that follows the bottom scrolls the terminal too; only a finger, or a fling it started, counts.
  const now = clock();
  if (!owned && ((touching > 0 && dragging) || now < flingUntil)) scrollUntil = Math.max(scrollUntil, now + scrollEventMs);
}
/** For owners that end a composition without a compositionend, such as a toolbar key that sends the composed word. */
export function endTextComposition() { composing = false; }

let installed = false;
function observe() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const options = {capture: true, passive: true};
  for (const name of ['keydown', 'beforeinput', 'input']) document.addEventListener(name, observeKeys, options);
  for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(name, observeComposition, options);
  for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.addEventListener(name, observeTouch, options);
  document.addEventListener('scroll', observeScroll, options);
  document.addEventListener('focusout', endTextComposition, options);
  window.addEventListener('blur', endTextComposition);
}
observe();

function textFieldFocused(): boolean {
  const element = document.activeElement;
  if (!element || element === document.body || element.classList.contains('xterm-helper-textarea')) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) return !nonTextInputs.has(element.type) && !element.readOnly && !element.disabled;
  return element instanceof HTMLElement && element.isContentEditable;
}
function rangeSelected(): boolean {
  // The terminal reports its own selection; its helper textarea mirrors it and is not a text selection here.
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.type !== 'Range') return false;
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  return !anchor?.closest('.xterm');
}

/** The kinds holding right now; empty when gestures may run. */
export function activeTextInteractions(): TextInteractionKind[] {
  const now = clock(), kinds = new Set<TextInteractionKind>();
  for (const {kind, probe} of probes.values()) if (probe()) kinds.add(kind);
  if (now - typedAt < typingWindowMs) kinds.add('typing');
  // A toolbar key can end a composition without a compositionend, so a quiet one expires.
  if (composing && now - composedAt < compositionStaleMs) kinds.add('composition');
  if (textFieldFocused()) kinds.add('field');
  if (rangeSelected()) kinds.add('selection');
  if (touching > 1 || now < pinchUntil) kinds.add('pinch');
  if (now < scrollUntil) kinds.add('scroll');
  return [...kinds];
}
export function isTextInteractionActive(): boolean { return activeTextInteractions().length > 0; }
