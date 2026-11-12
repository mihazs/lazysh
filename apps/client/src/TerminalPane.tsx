import {t,useUi,formatNumber} from './i18n/core';
import {captureUiError,LocalUiError,type UiErrorCause} from './i18n/localError';
import { checkPasteSize, readClipboardText, useClipboardPlatform } from './deviceClipboard';
import { subscribeAccess, useMountedAccess, useProtectedApi, useProtectedInvoke } from './access';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TerminalFitAddon } from "./terminalFit";
import {installTerminalLinks} from "./terminalLinks";
import { Keyboard, KeyboardOff, Lock, SquarePen } from "lucide-react";
import { toolbarIcons } from "./toolbarIcons";
import {observeHerdrHistory, scrollHerdrHistory} from './herdrTouchHistory';
import TerminalComposer, {composerDraftReady} from './TerminalComposer';
import {expandComposerDraft,insertComposerToken,liveComposerAttachments,nextComposerAttachmentNumber,onComposerAttachment,type ComposerAttachment} from './composerTokens';
import TerminalSelectionTools from './TerminalSelectionTools';
import {endTextComposition, markTyping, registerTextInteraction} from './textInteraction';
import { api as nativeApi } from "./bridge";
import { bodyGestureSlots, decodeClipboardRequest, toolbarKeyHeights, gestureLabelKeys, parseChord, parseChordSteps, savePreferences, toolbarKeyHasAlternate, toolbarKeyLabel, toolbarNavigationActions, toolbarRows, usePreferences, type GestureAction, type GestureSlot, type ToolbarAlternate, type ToolbarKey } from "./preferences";
import { isMultiplexerAction, multiplexerSteps, resolveGesture, storedPrefix, validPrefix, type MultiplexerAction } from "./multiplexerGestures";
import type {UnappliedTerminalEdit} from "./terminalIme";
import { keepViewportScrolls, modifiedTerminalText, observeTerminalInput, syncTerminalViewport, type LiveSession } from "./terminal";
import { applyTerminalTheme } from "./terminalBold";
import { nextTouchSelection, selectTerminalRange, terminalCellAt, terminalWordAt, TOUCH_SELECTION_DELAY, type TouchSelection } from "./terminalTouchSelection";
import { fontFamilyFor, fontWarningKey, fontWarningText, useDeviceFonts } from "./fonts";
import { errorMessage } from "./SessionTools";
import { carryKeyboard, keyboardCarried, mayFocusOnActivation, touchScreen } from "./softKeyboard";
import { herdrNavigationCell } from "./herdrNavigationCells";
import "@xterm/xterm/css/xterm.css";
import { toolbarColumns, visibleToolbarRows } from "./toolbarLayout";
import ToolbarPages, { type ToolbarPage } from "./ToolbarPages";
import "./ToolbarRows.css";
import "./TerminalGestures.css";

const sequences: Partial<Record<ToolbarKey, string>> = {esc: "\x1b", tab: "\t", c: "c", d: "d", enter: "\r", backspace: "\x7f", left: "\x1b[D", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C"};
const arrowLabelKeys = {left:"terminalArrowLeft",up:"terminalArrowUp",down:"terminalArrowDown",right:"terminalArrowRight"} as const;
const labels: Partial<Record<ToolbarKey, string>> = {left: "←", up: "↑", down: "↓", right: "→"};
type InputCaller = 'terminal-user' | 'terminal-nonuser' | 'named-key' | 'chord' | 'gesture';
type InputOwner = {session: LiveSession; disposed: boolean};
type DpadDirection = keyof typeof arrowLabelKeys;
type DpadGesture = {readonly shift:boolean;pointer:number;x:number;y:number;started:number;direction:DpadDirection|null;panned:boolean;sent:boolean;owner:InputOwner;terminal:LiveSession['terminal'];id:string};
type PullDepth = 'pullShallow' | 'pullDeep';
/** A header pull starts after 12 CSS pixels downward; 56 reaches the short depth and 144 the long one. */
const pullStart = 12, pullShallow = 56, pullDeep = 144;
/** Pinch text sizing follows the fingers; a discrete pinch action needs a clearer change of distance. */
const pinchResize = .08, pinchAction = .25;
const alternateHold = 500;

export function terminalWebUrl(value: string): string | undefined {
  if (value.length > 4096 || /[\s\x00-\x1f\x7f-\x9f\\]/.test(value) || !/^https?:\/\//i.test(value)) return;
  const authority = value.split('://')[1].split(/[/?#]/)[0];
  if (!authority || authority.includes('@')) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password && url.href.length <= 4096) return url.href;
  } catch { /* Ignore malformed remote links. */ }
}

export default function TerminalPane({ session, active, typingActivation = false, reportError, onOpenAttachments, controlsTarget, onBackChange, notice, herdrNavigationOnly = false }: {
  session: LiveSession;
  active: boolean;
  herdrNavigationOnly?: boolean;
  /** Activated by the user opening this terminal to type, which may raise the soft keyboard; navigating to a terminal never does. */
  typingActivation?: boolean;
  reportError: (message: UiErrorCause) => void;
  /** Opens the attachment tool; `composer` asks for the upload to return as a draft token. */
  onOpenAttachments?: (target?: 'composer') => void;
  controlsTarget?: HTMLElement | null;
  /** Connection state that replaces the generic ended notice, such as reconnect progress. */
  notice?: ReactNode;
  onBackChange?: (sessionId:string, close:(()=>boolean)|null)=>void;
}) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const invoke = useProtectedInvoke();
  const noGuardedHistory = useRef<string | undefined>(undefined);
  const { access, mounted } = useMountedAccess();
  const container = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const fit = useRef<(() => void) | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport, element = pane.current;
    if (!viewport || !element || !active) return;
    let frame = 0, inset = 0;
    const update = () => {
      const covered = viewport.scale === 1 ? Math.max(0, Math.round(element.getBoundingClientRect().bottom + inset - viewport.offsetTop - viewport.height)) : 0;
      if (covered !== inset) {inset = covered; element.style.marginBottom = covered ? `${covered}px` : '';}
    };
    const schedule = () => {cancelAnimationFrame(frame); frame = requestAnimationFrame(update);};
    update(); viewport.addEventListener('resize', schedule); viewport.addEventListener('scroll', schedule); window.addEventListener('resize', schedule);
    return () => {cancelAnimationFrame(frame); viewport.removeEventListener('resize', schedule); viewport.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); element.style.marginBottom = '';};
  }, [active]);
  const activeRef = useRef(active);
  const inputOwner = useRef<InputOwner | null>(null);
  activeRef.current = active;
  // Released once focus enters this terminal, so later activations are navigation again; each activation re-reads it.
  const typing = useRef(typingActivation);
  useEffect(() => {typing.current = typingActivation;}, [typingActivation, active]);
  const zellijBusy = useRef(false);
  useEffect(() => {activeRef.current = active; return () => {activeRef.current = false;};}, [active]);
  const preferences = usePreferences();
  const fonts = useDeviceFonts();
  const [ctrl, setCtrl] = useState(false);
  const [ctrlLocked, setCtrlLocked] = useState(false);
  const [dpadOpen, setDpadOpen] = useState(false);
  const [meta, setMeta] = useState(false);
  const [metaLocked, setMetaLocked] = useState(false);
  const [shift, setShift] = useState(false);
  const [modifierInput, setModifierInput] = useState(true);
  const modifierState = useRef({ctrl, ctrlLocked, meta, metaLocked, shift});
  modifierState.current = {ctrl, ctrlLocked, meta, metaLocked, shift};
  const inputLane = useRef<"keyboard" | "literal" | null>(null);
  const literalPaste = useRef(false);
  const literalCapture = useRef<string[] | null>(null);
  const imeInput = useRef<{readonly idle:boolean;reset(): void; flush(): void; settle(): void; resume(): void; dismiss(): void; composing(): boolean | undefined} | null>(null);
  const pointerInputEvent = useRef<Event | null>(null);
  const keyboardInputEvent = useRef<Event | null>(null);
  const repeated = useRef(false);
  // Counts held keys that began repeating or ran their long-press action, so a drag that follows a hold does not also turn the toolbar page.
  const repeatStarts = useRef(0);
  const repeatShift = useRef<boolean | undefined>(undefined);
  const repeat = useRef<{readonly shift?:boolean;delay?: ReturnType<typeof setTimeout>; timer?: ReturnType<typeof setInterval>}>({});
  const dpad = useRef<{pointers:Map<number,string>;pointerType:string;gesture:DpadGesture|null;blocked:boolean;suppressClick:boolean}>({pointers:new Map(),pointerType:"",gesture:null,blocked:false,suppressClick:false});
  const dpadView = useRef({session,enabled:false});
  const dpadElement = useRef<HTMLDivElement>(null);
  const [dpadDirection,setDpadDirection] = useState<DpadDirection|null>(null);
  function stopRepeat() {clearTimeout(repeat.current.delay); clearInterval(repeat.current.timer); repeat.current = {}; repeatShift.current = undefined;}
  function startRepeat(action:()=>void,delay=400,shift=modifierState.current.shift) {
    stopRepeat();const owner:typeof repeat.current={shift};repeat.current=owner;
    const tick=()=>{if(repeat.current!==owner)return;repeatShift.current=owner.shift;try{action();}finally{repeatShift.current=undefined;}};
    owner.delay=setTimeout(()=>{if(repeat.current!==owner)return;repeated.current=true;repeatStarts.current++;tick();if(repeat.current===owner&&!document.hidden)owner.timer=setInterval(tick,80);},delay);
  }
  // A toolbar key with a long-press action runs it once after a hold instead of repeating.
  const held = useRef<{key: ToolbarKey; fired: boolean; timer?: ReturnType<typeof setTimeout>} | null>(null);
  function releaseHold() {if (held.current) clearTimeout(held.current.timer);}
  function holdAlternate(key: ToolbarKey, alternate: ToolbarAlternate) {
    releaseHold();
    const owner: NonNullable<typeof held.current> = {key, fired: false};
    owner.timer = setTimeout(() => {if (held.current === owner) fireAlternate(key, alternate);}, alternateHold);
    held.current = owner;
  }
  /** Runs at most once per press, whether the hold timer or the platform's context menu comes first. */
  function fireAlternate(key: ToolbarKey, alternate: ToolbarAlternate) {
    if (held.current?.key === key && held.current.fired) return;
    releaseHold();
    held.current = {key, fired: true};
    repeatStarts.current++;
    if (activeRef.current && session.connected && mounted.current && access.current() && !document.hidden) runGesture(alternate.action, undefined, alternate.keys);
  }
  function cancelDpad() {
    stopRepeat();dpad.current.gesture=null;dpad.current.blocked=dpad.current.pointers.size>0;dpad.current.suppressClick=true;
    if(mounted.current)setDpadDirection(null);
  }
  function clearModifiers() {setCtrl(false); setCtrlLocked(false); setMeta(false); setMetaLocked(false); setShift(false); modifierState.current = {ctrl:false, ctrlLocked:false, meta:false, metaLocked:false, shift:false}; inputLane.current = null; pointerInputEvent.current = null; keyboardInputEvent.current = null; cancelDpad();}
  function consumeModifiers() {const state = modifierState.current; if (!state.ctrlLocked) {state.ctrl = false; setCtrl(false);} if (!state.metaLocked) {state.meta = false; setMeta(false);} state.shift = false; setShift(false);}
  /** The accepted paste bytes (bracketed when the program asked for it) leave as one write; with submit, a separate Enter follows in one paced sequence. Resolves true only once the write was accepted, so a caller keeps its text otherwise. */
  async function pasteLiteral(text: string, submit = false): Promise<boolean> {
    imeInput.current?.flush();
    const accepted: string[] = [];
    literalPaste.current = true; literalCapture.current = accepted;
    try {session.terminal.paste(text);} finally {literalPaste.current = false; literalCapture.current = null;}
    const pasted = accepted.join("");
    if (!pasted || !session.connected) return false;
    try {await writeInput('terminal-user', submit ? [pasted, "\r"] : pasted); return true;}
    catch (error) {reportError(captureUiError(error)); return false;}
  }
  const sendNamedRef = useRef<(key: string, physical?: KeyboardEvent, owner?:InputOwner) => boolean>(() => false);
  const [unappliedEdit, setUnappliedEdit] = useState<UnappliedTerminalEdit | null>(null);
  const editReview = useRef<HTMLDetailsElement>(null);
  // A skipped keyboard edit never pauses typing; its notice fades unless it is being reviewed.
  useEffect(() => {
    if (!unappliedEdit) return;
    const timer = setTimeout(() => {if (!editReview.current?.open) setUnappliedEdit(null);}, 8000);
    return () => clearTimeout(timer);
  }, [unappliedEdit]);
  const [clipboard, setClipboard] = useState<string | null>(null);
  const pendingClipboard = useRef(false);
  const pasteRead = useRef<AbortController | null>(null);
  const clipboardPlatform = useClipboardPlatform();
  const [pasteBusy, setPasteBusy] = useState(false);
  const pasteView = useRef({active, connected: session.connected, id: session.id, terminal: session.terminal});
  pasteView.current = {active, connected: session.connected, id: session.id, terminal: session.terminal};
  function writeInput(caller: InputCaller, data: string | string[], owner = inputOwner.current) {
    // Toolbar keys and chords are typing too (keyboard input is seen as key events; wheel reports and gestures are not typing).
    if (caller === 'named-key' || caller === 'chord') markTyping();
    const snapshot = () => {
      const sameView = !!owner && pasteView.current.id === owner.session.id && pasteView.current.terminal === owner.session.terminal;
      return {active: activeRef.current, connected: sameView ? pasteView.current.connected : !!owner?.session.connected,
        disposed: !owner || owner.disposed, currentOwner: !!owner && inputOwner.current === owner && sameView};
    };
    const dispatch = snapshot();
    const utf16Units = Math.min(65536, typeof data === 'string' ? data.length : data.reduce((size, step) => Math.min(65536, size + step.length), 0));
    const pending = typeof data === 'string' ? api.write(session.id, data) : api.writeSequence(session.id, data);
    return pending.catch(error => {
      const kind = error && typeof error === 'object' && 'kind' in error ? error.kind : undefined;
      const cause = kind === 'backpressure' ? 'queue-full' : kind === 'input_closed' ? 'channel-closed' : 'other';
      // Never retain terminal content, identifiers, or raw errors in this receipt.
      try {console.warn('lazysh-terminal-input ' + JSON.stringify({caller, cause, utf16Units, dispatch, receipt: snapshot()}));}
      catch {/* Optional diagnostics cannot change delivery or error visibility. */}
      throw error;
    });
  }
  useEffect(() => () => { pasteRead.current?.abort(); }, [session.id, session.terminal, session.connected, active]);
  const [link, setLink] = useState<string | null>(null);
  const [openingLink, setOpeningLink] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchLine = useRef(-1);
  const [searchStatus, setSearchStatus] = useState<number | "none" | null>(null);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(composing);
  composingRef.current = composing;
  // Leaving this terminal while an input holds focus keeps the soft keyboard up for what takes over; so does closing the composer, which the user opened to type.
  const was = useRef({active, composing});
  if (was.current.active && !active) carryKeyboard();
  else if (was.current.composing && !composing) carryKeyboard(true);
  was.current = {active, composing};
  const [draft, setDraft] = useState("");
  // Uploads stay known for the life of the draft, so undo or an IME correction
  // that restores a deleted token restores its attachment; only tokens still in
  // the draft show as chips and expand on send.
  const [draftAttachments, setDraftAttachments] = useState<readonly ComposerAttachment[]>([]);
  const draftAttachmentsRef = useRef(draftAttachments);
  draftAttachmentsRef.current = draftAttachments;
  const liveAttachments = useMemo(() => liveComposerAttachments(draft, draftAttachments), [draft, draftAttachments]);
  const liveAttachmentsRef = useRef(liveAttachments);
  liveAttachmentsRef.current = liveAttachments;
  // Expanded input tools share the keyboard-sized workspace.
  useEffect(()=>{if(composing)setDpadOpen(false);},[composing]);
  // Edge swipes never run while this terminal has a selection or a composing keyboard.
  useEffect(() => {
    if (!active) return;
    const release = [registerTextInteraction('selection', () => session.terminal.hasSelection()), registerTextInteraction('composition', () => !!composingIme())];
    return () => release.forEach(stop => stop());
  }, [active, session.terminal]);
  // Selection handles appear after a touch long-press; actions also after a mouse selection.
  const [selectionTools, setSelectionTools] = useState<{handles: boolean} | null>(null);
  useEffect(() => setSelectionTools(null), [session.id, session.terminal]);
  useEffect(()=>{
    const available=active && (composing || searching || clipboard!==null || link!==null || dpadOpen || selectionTools!==null);
    onBackChange?.(session.id,available?()=>{
      if(!activeRef.current || !mounted.current || !access.current())return false;
      if(selectionTools!==null)session.terminal.clearSelection();
      else if(clipboard!==null){setClipboard(null);pendingClipboard.current=false;}
      else if(link!==null)setLink(null);
      else if(searching)setSearching(false);
      else if(composing)setComposing(false);
      else setDpadOpen(false);
      return true;
    }:null);
    return()=>onBackChange?.(session.id,null);
  },[active,composing,searching,clipboard,link,dpadOpen,selectionTools,session.id,onBackChange]);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [toolbarOverride, setToolbarOverride] = useState<boolean | null>(null);
  const [desktopPointer, setDesktopPointer] = useState(false);
  const imeComposing = useRef(false);
  // A toolbar key or a revoked editor ends the composition by clearing the
  // editor, and the browser then sends no compositionend: trust the IME owner.
  // Read the flag only through composingIme(); a direct read of
  // imeComposing.current can see that stale composition.
  const composingIme = () => {
    if (imeComposing.current && imeInput.current?.composing() === false) {imeComposing.current = false; endTextComposition();}
    return imeComposing.current;
  };
  const pointers = useRef(new Map<number, {x: number; y: number}>());
  const press = useRef<{id: number; x: number; y: number; when: number; moved: boolean} | null>(null);
  const taps = useRef<{count: number; when: number; x: number; y: number; timer?: ReturnType<typeof setTimeout>} | null>(null);
  const gesture = useRef<{x: number; y: number; distance: number; fontSize: number; zoomed: boolean; moved: Set<number>} | null>(null);
  const toolbarVisible = toolbarOverride ?? !(preferences.autoHideToolbar && desktopPointer);
  const dpadEnabled=toolbarVisible&&dpadOpen&&preferences.toolbar.includes('dpad');
  dpadView.current={session,enabled:dpadEnabled};
  function ownsDpad(gesture:DpadGesture) {
    return dpadView.current.enabled&&dpadView.current.session.id===gesture.id&&dpadView.current.session.terminal===gesture.terminal
      &&inputOwner.current===gesture.owner&&!gesture.owner.disposed&&gesture.owner.session.id===gesture.id&&gesture.owner.session.terminal===gesture.terminal
      &&activeRef.current&&dpadView.current.session.connected&&mounted.current&&access.current()&&!document.hidden
      &&!document.querySelector('[role="dialog"][aria-modal="true"]');
  }
  function armDpad(gesture:DpadGesture) {
    if(!gesture.direction){stopRepeat();return;}
    const age=performance.now()-gesture.started;
    startRepeat(()=>{
      if(dpad.current.gesture!==gesture||!ownsDpad(gesture)||!gesture.direction){cancelDpad();return;}
      if(!sendNamedRef.current(gesture.direction[0].toUpperCase()+gesture.direction.slice(1),undefined,gesture.owner)){cancelDpad();return;}
      gesture.sent=true;
    },age>=400?80:400-age,gesture.shift);
  }
  function dpadDown(event:ReactPointerEvent<HTMLDivElement>) {
    const state=dpad.current;
    if(event.isPrimary===false){state.suppressClick=true;return;}
    if(state.pointers.size||state.blocked)return;
    state.suppressClick=false;
    const button=(event.target as Element).closest<HTMLButtonElement>('button[data-dpad-direction]');
    if(!button||event.button!==0||!inputOwner.current)return;
    event.preventDefault();
    const gesture:DpadGesture={shift:modifierState.current.shift,pointer:event.pointerId,x:event.clientX,y:event.clientY,started:performance.now(),direction:button.dataset.dpadDirection as DpadDirection,panned:false,sent:false,owner:inputOwner.current,terminal:session.terminal,id:session.id};
    if(!ownsDpad(gesture)||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return;
    // Without capture, preserve ordinary clicks but do not start an unowned hold.
    if(!event.currentTarget.setPointerCapture)return;
    try {event.currentTarget.setPointerCapture(event.pointerId);}catch{return;}
    state.pointers.set(event.pointerId,event.pointerType);state.pointerType=event.pointerType;state.gesture=gesture;setDpadDirection(gesture.direction);armDpad(gesture);
  }
  function dpadMove(event:ReactPointerEvent<HTMLDivElement>) {
    const gesture=dpad.current.gesture;
    if(!gesture||event.pointerId!==gesture.pointer)return;
    if(!ownsDpad(gesture)||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY)){cancelDpad();return;}
    event.preventDefault();const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
    // Original displacement design: twelve CSS pixels separates drift from pan.
    if(Math.max(Math.abs(dx),Math.abs(dy))>=12)gesture.panned=true;
    if(!gesture.panned)return;
    const direction:DpadDirection|null=Math.max(Math.abs(dx),Math.abs(dy))<12?null:Math.abs(dx)>Math.abs(dy)?dx>0?'right':'left':dy>0?'down':'up';
    if(direction===gesture.direction)return;
    gesture.direction=direction;setDpadDirection(direction);armDpad(gesture);
  }
  useEffect(()=>{
    const down=(event:PointerEvent)=>{
      const state=dpad.current;
      // A new primary of the same pointer type proves its old contacts ended,
      // even when their release was lost outside this document. Other types
      // remain tracked: a mouse must not rearm while a touch is still held.
      if(!state.gesture&&state.blocked&&event.isPrimary&&event.pointerType===state.pointerType){
        for(const [id,type] of state.pointers)if(type===event.pointerType)state.pointers.delete(id);
        state.blocked=state.pointers.size>0;
      }
      if(state.pointers.size&&!state.pointers.has(event.pointerId)){state.pointers.set(event.pointerId,event.pointerType);cancelDpad();}
    };
    const end=(event:PointerEvent)=>{
      const state=dpad.current,gesture=state.gesture;
      if(gesture?.pointer===event.pointerId){
        if(!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY)||Math.max(Math.abs(event.clientX-gesture.x),Math.abs(event.clientY-gesture.y))>=12)gesture.panned=true;
        if(event.type==='pointerup'&&!gesture.panned&&!gesture.sent&&ownsDpad(gesture)&&gesture.direction)sendNamedRef.current(gesture.direction[0].toUpperCase()+gesture.direction.slice(1),undefined,gesture.owner);
        cancelDpad();
      }
      state.pointers.delete(event.pointerId);if(state.pointers.size===0)state.blocked=false;
    };
    const blur=()=>{if(dpad.current.pointers.size)cancelDpad();};
    const focus=()=>{if(document.querySelector('[role="dialog"][aria-modal="true"]'))blur();};
    document.addEventListener('pointerdown',down,true);document.addEventListener('pointerup',end,true);document.addEventListener('pointercancel',end,true);
    document.addEventListener('focusin',focus,true);window.addEventListener('blur',blur);
    return()=>{cancelDpad();document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointerup',end,true);document.removeEventListener('pointercancel',end,true);document.removeEventListener('focusin',focus,true);window.removeEventListener('blur',blur);};
  },[]);
  useEffect(()=>{if(!active||!session.connected||!dpadEnabled)cancelDpad();return cancelDpad;},[active,session.id,session.terminal,session.connected,dpadEnabled]);
  useEffect(()=>{
    const element=dpadElement.current;
    if(!element||!dpadEnabled||preferences.screenReader)return;
    const start=(event:TouchEvent)=>{
      const state=dpad.current,gesture=state.gesture;
      const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button[data-dpad-direction]'):null;
      // Pointer admission precedes touchstart. Consume only that owned direction
      // so Chromium cannot begin its separate long-press gesture on this control.
      if(!gesture||state.blocked||state.pointers.size!==1||state.pointers.get(gesture.pointer)!=='touch'
        ||event.touches.length!==1||!button||!element.contains(button)||button.disabled||!ownsDpad(gesture))return;
      if(event.cancelable)event.preventDefault();
    };
    element.addEventListener('touchstart',start,{passive:false});
    return()=>element.removeEventListener('touchstart',start);
  },[active,session.id,session.terminal,session.connected,dpadEnabled,preferences.screenReader]);
  const multiplexer = session.local ? undefined : session.attached?.kind;
  const customTouch = !preferences.screenReader && (preferences.pinchZoom || Object.values(preferences.gestures).some(action => action !== "none") || bodyGestureSlots.some(slot => preferences.bodyGestures[slot] !== "none") || (!!multiplexer && preferences.bodyGestures.pinch !== "none"));

  useEffect(() => {
    const visibility = () => {if (document.hidden) {imeInput.current?.reset(); clearModifiers(); repeated.current = true;}};
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => subscribeAccess(() => {if (!access.current()) {imeInput.current?.reset(); clearModifiers();}}), []);
  useEffect(() => {if (!active || !session.connected) imeInput.current?.reset();}, [active, session.connected, session.id]);
  useEffect(() => {if (!active || !session.connected || !toolbarVisible) clearModifiers(); return () => {stopRepeat(); releaseHold(); held.current = null;};}, [active, session.connected, toolbarVisible, session.id]);
  useEffect(() => {pointers.current.clear(); gesture.current = null; press.current = null; cancelTaps();}, [customTouch]);
  useEffect(() => {if (!active) cancelTaps(); return cancelTaps;}, [active, session.id, preferences.bodyGestures]);

  useEffect(() => {
    const stage = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (!detail || typeof detail !== "object") return;
      const { sessionId, text } = detail as Record<string, unknown>;
      if (sessionId !== session.id || typeof text !== "string" || text.length === 0 || text.length > 65536) return;
      const next = draftRef.current ? `${draftRef.current}\n\n${text}` : text;
      if (next.length > 65536) {reportError(new LocalUiError('terminalDraftLimit')); return;}
      draftRef.current = next;
      setDraft(next); setComposing(true);
    };
    window.addEventListener("lazysh-prompt-draft", stage);
    return () => window.removeEventListener("lazysh-prompt-draft", stage);
  }, [session.id, reportError]);
  useEffect(() => onComposerAttachment(session.id, staged => {
    const known = draftAttachmentsRef.current;
    const attachment: ComposerAttachment = {...staged, number: nextComposerAttachmentNumber(draftRef.current, known)};
    const editor = composerInput.current;
    const inserted = insertComposerToken(draftRef.current, editor ? editor.selectionStart : draftRef.current.length, attachment, liveAttachmentsRef.current);
    if (inserted.value.length > 65536) {reportError(new LocalUiError('terminalDraftLimit')); return;}
    draftRef.current = inserted.value; draftAttachmentsRef.current = [...known, attachment];
    setDraft(inserted.value); setDraftAttachments(draftAttachmentsRef.current); setComposing(true);
  }), [session.id, reportError]);

  useEffect(() => {
    if (composing && active && draft) focusTerminal(composerInput.current);
  }, [composing, active, draft]);

  useEffect(() => {
    const element = container.current;
    if (!element || preferences.screenReader) return;
    let alive = true;
    let historyQueue: Promise<void> = Promise.resolve();
    let historyGesture: {target?: unknown; failed: boolean; cancelled?: boolean} = {failed:false};
    let historyTail: {gesture: typeof historyGesture; x:number; y:number; lines:number; started:boolean} | null = null;
    const historyScroll = (x: number, y: number, lines: number) => {
      const terminal = session.terminal, rect = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!rect || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0 || !terminal.cols || !terminal.rows) return;
      const column = Math.floor((x - rect.left) * terminal.cols / rect.width), row = Math.floor((y - rect.top) * terminal.rows / rect.height);
      if (column < 0 || row < 0 || column >= terminal.cols || row >= terminal.rows) return;
      const gesture = historyGesture;
      if (historyTail && !historyTail.started && historyTail.gesture === gesture && historyTail.x === column && historyTail.y === row
        && Math.sign(historyTail.lines) === Math.sign(lines) && Math.abs(historyTail.lines + lines) <= 200) {historyTail.lines += lines; return;}
      const batch = {gesture, x:column, y:row, lines, started:false};
      historyTail = batch;
      historyQueue = historyQueue.then(async () => {
        batch.started = true;
        if (historyTail === batch) historyTail = null;
        if (!alive || !activeRef.current || !session.connected || !access.current() || gesture.failed || gesture.cancelled) return;
        if (!gesture.target) {
          gesture.target = await observeHerdrHistory(invoke, session.id);
        }
        if (!alive || !activeRef.current || !session.connected || !access.current() || gesture.cancelled) return;
        await scrollHerdrHistory(invoke, session.id, gesture.target, batch.x, batch.y, batch.lines);
      }).catch((error: {kind?: string} | undefined) => {
        const first = !gesture.failed;
        gesture.failed = true;
        if (!first || gesture.cancelled || !alive || !activeRef.current || !access.current()) return;
        // A host that cannot serve guarded history at all (stock Herdr, an older running server) must not fail every swipe: keep the wheel path for the session. Only a busy guard is transient.
        if (!gesture.target && error?.kind !== 'herdr_chat_busy') {noGuardedHistory.current = session.id; return;}
        reportError(new LocalUiError('unavailable'));
      });
    };
    let remainder: {mode: string; height: number; pending: number; direction: number} | null = null;
    let scroll: {x: number; y: number; lastY: number; pending: number; direction: number; mode: string | null; height: number; active: boolean; dismiss:InputOwner|null} | null = null;
    // Edge swipes wait while this terminal's own finger scroll runs.
    const scrolling = registerTextInteraction('scroll', () => !!scroll?.active);
    const safeDismiss=(owner:InputOwner|null)=>{
      const terminal=session.terminal,area=terminal.textarea,buffer=terminal.buffer.active,view=pasteView.current;
      return !!owner&&inputOwner.current===owner&&!owner.disposed&&owner.session.id===session.id&&owner.session.terminal===terminal
        &&view.id===session.id&&view.terminal===terminal&&view.connected&&activeRef.current&&mounted.current&&access.current()
        &&!document.hidden&&document.hasFocus()&&!composingIme()&&imeInput.current?.idle===true&&!terminal.hasSelection()
        &&area===document.activeElement&&!area?.readOnly&&area?.value===''
        &&terminal.modes.mouseTrackingMode==='none'&&buffer.type==='normal'&&Number.isInteger(buffer.baseY)&&buffer.baseY>=0&&buffer.viewportY===buffer.baseY
        &&!document.querySelector('[role="dialog"][aria-modal="true"]');
    };
    const retireDismiss=()=>{if(scroll)scroll.dismiss=null;};
    // A finger held still and lifted selects the word beneath it; a later
    // long-press elsewhere extends that selection. Moving first always scrolls.
    let hold: {x: number; y: number; timer?: ReturnType<typeof setTimeout>; ready?: true} | null = null;
    let touched: TouchSelection | null = null;
    const release = () => {if (hold?.timer) clearTimeout(hold.timer); hold = null;};
    const cancel = () => {historyGesture.cancelled = true; scroll = null; remainder = null; release();};
    const start = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!point) {cancel(); return;}
      historyGesture = {failed:false};
      scroll = {x: point.clientX, y: point.clientY, lastY: point.clientY, pending: 0, direction: 0, mode: null, height: 0, active: false, dismiss:preferences.dismissKeyboardOnOverscroll&&Number.isFinite(point.clientX)&&Number.isFinite(point.clientY)&&safeDismiss(inputOwner.current)?inputOwner.current:null};
      release();
      const pending: NonNullable<typeof hold> = {x: point.clientX, y: point.clientY};
      pending.timer = setTimeout(() => {pending.timer = undefined; pending.ready = true;}, TOUCH_SELECTION_DELAY);
      hold = pending;
    };
    // The platform's long-press menu would otherwise compete with terminal selection.
    const menu = (event: Event) => {if (hold) event.preventDefault();};
    const selectHeld = () => {
      const cell = hold?.ready && !scroll?.active && !composingIme() && activeRef.current ? terminalCellAt(session.terminal, hold.x, hold.y) : undefined;
      if (!cell) return false;
      touched = nextTouchSelection(touched && session.terminal.hasSelection() ? touched : null, terminalWordAt(session.terminal, cell));
      selectTerminalRange(session.terminal, touched.range);
      setSelectionTools({handles: true});
      press.current = null; gesture.current = null; pointers.current.clear(); cancelTaps();
      return true;
    };
    const end = (event: TouchEvent) => {
      if (selectHeld()) {
        // Without the follow-up compatibility click, xterm keeps the new selection.
        if (event.cancelable) event.preventDefault();
        cancel(); return;
      }
      // A tap dismisses a touch selection, as on the platform's own text views.
      if (hold && !hold.ready && !scroll?.active && touched && session.terminal.hasSelection()) {session.terminal.clearSelection(); touched = null;}
      release();
      remainder = scroll?.active && scroll.mode && activeRef.current && session.connected ? {mode: scroll.mode, height: scroll.height, pending: scroll.pending % scroll.height, direction: scroll.direction} : null;
      scroll = null;
    };
    const multitouch = (event: TouchEvent) => {
      if (!activeRef.current) {cancel(); return;}
      if (event.touches.length === 1) {
        const point = event.touches[0];
        if (hold && Math.hypot(point.clientX - hold.x, point.clientY - hold.y) > 10) release();
        if (scroll) {
          const dx = point.clientX - scroll.x, dy = point.clientY - scroll.y;
          if(scroll.dismiss&&(!safeDismiss(scroll.dismiss)||!Number.isFinite(dx)||!Number.isFinite(dy)||point.clientY>scroll.lastY||Math.abs(dx)>Math.max(10,Math.abs(dy)/1.5)))retireDismiss();
          if (scroll.active || (Math.abs(dy) >= 10 && Math.abs(dy) > Math.abs(dx))) {
            const deltaY = scroll.lastY - point.clientY;
            scroll.active = true; scroll.lastY = point.clientY;
            press.current = null; cancelTaps();
            // An upward finger moves toward the bottom of local history.
            if(scroll.dismiss&&-dy>=48){
              retireDismiss();session.terminal.blur();event.stopPropagation();if(event.cancelable)event.preventDefault();return;
            }
            const tracking = session.terminal.modes.mouseTrackingMode;
            const pixelWheel = tracking === 'none' || tracking === 'x10';
            const viewportScroll = pixelWheel && session.terminal.buffer.active.type !== 'alternate' && session.terminal.options.scrollback !== 0;
            const herdrHistory = multiplexer === 'herdr' && noGuardedHistory.current !== session.id && !viewportScroll;
            const route = `${herdrHistory}:${tracking}:${viewportScroll}:${session.terminal.buffer.active.type}:${session.terminal.options.scrollback === 0}`;
            const height = (session.terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0) / session.terminal.rows;
            let count = 1, amount = deltaY, lines = 0;
            let mode: number = WheelEvent.DOM_DELTA_PIXEL;
            if (Number.isFinite(height) && height > 0) {
              // xterm rounds visible rows and retains partial wheel travel between events.
              // Keep the same debt across admitted drags, fenced by mode and cell geometry.
              if (scroll.mode !== route || scroll.height !== height) {
                const previous = remainder?.mode === route && remainder.height === height ? remainder : null;
                scroll.pending = previous?.pending ?? 0; scroll.direction = previous?.direction ?? 0;
                scroll.mode = route; scroll.height = height; remainder = null;
              }
              if (deltaY) {
                if (scroll.direction && Math.sign(deltaY) !== scroll.direction) scroll.pending = 0;
                scroll.direction = Math.sign(deltaY);
              }
              scroll.pending += deltaY;
              // A coalesced native sample can span the viewport. Drain its full
              // travel now; a later move may never arrive before finger lift.
              const limit = Math.min(herdrHistory ? 200 : 256, Math.max(1, Math.ceil(window.innerHeight / height)));
              const rows = viewportScroll ? Math.round(scroll.pending / height) : Math.trunc(scroll.pending / height);
              count = Math.min(limit, Math.abs(rows));
              amount = Math.sign(rows); mode = WheelEvent.DOM_DELTA_LINE;
              scroll.pending -= amount * count * height;
              // History scrolls synchronously: a wheel lands on the next scroll
              // event, after which streaming output could already have moved
              // a reader who was following the bottom row.
              if (herdrHistory) {if (count) historyScroll(scroll.x, scroll.y, amount * count); count = 0;}
              else if (viewportScroll) {lines = amount * count; count = 0;}
              else if (pixelWheel) {
                amount *= count * height; count = count ? 1 : 0; mode = WheelEvent.DOM_DELTA_PIXEL;
              }
            } else {scroll.pending = 0; remainder = null; scroll.mode = null; scroll.height = 0;}
            if (herdrHistory) count = 0;
            for (let notch = 0; notch < count; notch++) session.terminal.element?.dispatchEvent(new WheelEvent('wheel', {
              // Keep the whole drag in its original pane, as with a stationary mouse wheel.
              bubbles: true, cancelable: true, clientX: scroll.x, clientY: scroll.y, deltaY: amount, deltaMode: mode,
            }));
            if (lines) session.terminal.scrollLines(lines);
            event.stopPropagation();
            if (event.cancelable) event.preventDefault();
            return;
          }
        }
        // A composition rules out swipe gestures, not scrolling: a drag whose first
        // samples are short or slanted still scrolls once it moves vertically.
        if (composingIme()) return;
        if (session.terminal.hasSelection()) return;
        const start = press.current;
        if (!start) return;
        const dx = event.touches[0].clientX - start.x, dy = event.touches[0].clientY - start.y;
        const action = preferences.bodyGestures[dx < 0 ? "swipeLeft" : "swipeRight"];
        if (action === "none" || Math.abs(dx) < 16 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      } else {cancel(); if (composingIme() || session.terminal.hasSelection() || event.touches.length !== 2 || !customTouch) return;}
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    };
    const visibility=()=>{if(document.hidden)retireDismiss();};
    const selection=()=>{if(session.terminal.hasSelection())retireDismiss();};
    const accessChanged=subscribeAccess(()=>{if(!access.current())retireDismiss();});
    const bufferChanged=session.terminal.buffer.onBufferChange?.(retireDismiss);
    document.addEventListener('visibilitychange',visibility);document.addEventListener('selectionchange',selection);window.addEventListener('blur',retireDismiss);
    for(const name of ['compositionstart','input','focusout'])element.addEventListener(name,retireDismiss,true);
    element.addEventListener('touchstart', start, {capture: true, passive: true});
    element.addEventListener("touchmove", multitouch, {capture: true, passive: false});
    element.addEventListener('touchend', end, {capture: true});
    element.addEventListener('touchcancel', cancel, {capture: true});
    element.addEventListener('contextmenu', menu, {capture: true});
    return () => {
      alive = false;
      scrolling();
      release();
      element.removeEventListener('contextmenu', menu, {capture: true});
      accessChanged();bufferChanged?.dispose();
      document.removeEventListener('visibilitychange',visibility);document.removeEventListener('selectionchange',selection);window.removeEventListener('blur',retireDismiss);
      for(const name of ['compositionstart','input','focusout'])element.removeEventListener(name,retireDismiss,true);
      element.removeEventListener('touchstart', start, {capture: true});
      element.removeEventListener('touchmove', multitouch, {capture: true});
      element.removeEventListener('touchend', end, {capture: true});
      element.removeEventListener('touchcancel', cancel, {capture: true});
    };
  }, [active, customTouch, preferences.screenReader, preferences.dismissKeyboardOnOverscroll, session.id, session.terminal, session.connected, preferences.bodyGestures, multiplexer, invoke, access, reportError]);

  // Pulling the session header down runs the short or long pull action on release.
  const [pull, setPull] = useState<PullDepth | null>(null);
  const runPull = useRef<(depth: PullDepth) => void>(() => {});
  runPull.current = depth => {
    if (activeRef.current && mounted.current && access.current() && !document.hidden && !document.querySelector('[role="dialog"][aria-modal="true"]')) runGesture(preferences.bodyGestures[depth], depth);
  };
  // Without a pull action the header keeps its native touch scrolling.
  const pulls = (['pullShallow', 'pullDeep'] as const).some(depth => resolveGesture(preferences.bodyGestures[depth], depth, multiplexer, session.local) !== "none");
  useEffect(() => {
    const header = controlsTarget?.closest('header');
    if (!header || !active || preferences.screenReader || !pulls) return;
    let start: {x: number; y: number; id: number; pulling: boolean; depth: PullDepth | null} | null = null;
    const reset = () => {start = null; setPull(null);};
    const down = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      reset();
      if (touch) start = {x: touch.clientX, y: touch.clientY, id: touch.identifier, pulling: false, depth: null};
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches.length === 1 && event.touches[0].identifier === start.id ? event.touches[0] : undefined;
      if (!touch) {reset(); return;}
      const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
      if (!start.pulling) {
        if (dy < pullStart) {if (Math.hypot(dx, dy) >= pullStart) reset(); return;}
        if (Math.abs(dx) > dy) {reset(); return;}
        start.pulling = true;
      }
      if (event.cancelable) event.preventDefault();
      const depth = dy >= pullDeep ? 'pullDeep' : dy >= pullShallow ? 'pullShallow' : null;
      if (depth !== start.depth) {start.depth = depth; setPull(depth);}
    };
    const up = () => {
      const depth = start?.pulling ? start.depth : null;
      reset();
      if (depth) runPull.current(depth);
    };
    header.addEventListener('touchstart', down, {passive: true});
    header.addEventListener('touchmove', move, {passive: false});
    header.addEventListener('touchend', up);
    header.addEventListener('touchcancel', reset);
    return () => {
      header.removeEventListener('touchstart', down);
      header.removeEventListener('touchmove', move);
      header.removeEventListener('touchend', up);
      header.removeEventListener('touchcancel', reset);
      setPull(null);
    };
  }, [controlsTarget, active, preferences.screenReader, session.id, pulls]);
  const pullAction = pull ? resolveGesture(preferences.bodyGestures[pull], pull, multiplexer, session.local) : "none";

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // xterm owns mouse selection, including its edge scrolling; offer actions once it ends.
    let pressed = false;
    const down = (event: MouseEvent) => {pressed = event.button === 0;};
    const up = () => {if (pressed && activeRef.current && session.terminal.hasSelection()) setSelectionTools(current => current ?? {handles: false}); pressed = false;};
    element.addEventListener('mousedown', down, true);
    document.addEventListener('mouseup', up, true);
    return () => {element.removeEventListener('mousedown', down, true); document.removeEventListener('mouseup', up, true);};
  }, [session.id, session.terminal]);

  // A press on Herdr's own switch button or switcher navigates; xterm would also focus its input and raise the soft keyboard.
  useEffect(() => {
    const element = container.current, terminal = session.terminal;
    if (!element || multiplexer !== 'herdr') return;
    const press = (event: MouseEvent) => {
      const input = terminal.textarea, cell = terminalCellAt(terminal, event.clientX, event.clientY);
      if (!input || !cell || document.activeElement === input || !touchScreen()) return;
      // The press still reaches Herdr as a click; only the focus xterm gives its input on a press is refused.
      if (herdrNavigationCell(terminal, cell.x, cell.y - terminal.buffer.active.viewportY)) {input.disabled = true; setTimeout(() => {input.disabled = false;});}
    };
    element.addEventListener('mousedown', press, true);
    return () => element.removeEventListener('mousedown', press, true);
  }, [session.id, session.terminal, multiplexer]);

  useEffect(() => {
    const query = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    if (!query) return;
    const update = () => setDesktopPointer(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const terminal = session.terminal;
    const addon = new TerminalFitAddon();
    terminal.loadAddon(addon);
    const links = installTerminalLinks(terminal, uri => {
      const url = terminalWebUrl(uri);
      if (url) setLink(url);
    });
    const osc = terminal.parser.registerOscHandler(52, data => {
      const text = decodeClipboardRequest(data);
      if (text !== undefined && !pendingClipboard.current) {
        pendingClipboard.current = true;
        setClipboard(text);
      }
      return true;
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === "keydown" && !event.isComposing && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        setSearching(true);
        requestAnimationFrame(() => focusTerminal(searchInput.current));
        return false;
      }
      const state = modifierState.current;
      if (event.type === "keydown" && !event.isComposing && !event.metaKey && !event.getModifierState?.("AltGraph") && (state.ctrl || state.meta) && /^[ -~]$/.test(event.key) && !(event.ctrlKey && (/^v$/i.test(event.key) || (event.shiftKey && /^c$/i.test(event.key))))) {
        event.preventDefault(); sendNamedRef.current(event.key === " " ? "Space" : event.key, event); return false;
      }
      const named = {ArrowLeft:"Left", ArrowRight:"Right", ArrowUp:"Up", ArrowDown:"Down", Escape:"Escape", Tab:"Tab", Enter:"Enter", Backspace:"Backspace", Home:"Home", End:"End", PageUp:"PageUp", PageDown:"PageDown", Insert:"Insert", Delete:"Delete"} as Record<string,string>;
      if (event.type === "keydown" && !event.isComposing && (state.ctrl || state.meta || state.shift || (event.key === "Enter" && event.shiftKey && !event.metaKey && !event.getModifierState?.("AltGraph"))) && (named[event.key] || /^F(?:[1-9]|1[0-2])$/.test(event.key))) {
        event.preventDefault(); sendNamedRef.current(named[event.key] ?? event.key, event); return false;
      }
      return true;
    });
    if (terminal.element) element.append(terminal.element);
    else terminal.open(element);
    try {applyTerminalTheme(terminal, preferences, fontFamilyFor(preferences, fonts));} catch (error) {reportError(String(error));}
    const keyboardLane = (event: Event) => {if (event.target === terminal.textarea) {inputLane.current = "keyboard"; keyboardInputEvent.current = event;}};
    const literalLane = () => {inputLane.current = "literal";};
    const pointerLane = (event: Event) => {pointerInputEvent.current = event;};
    const lanes = ["keydown", "keypress", "input", "compositionstart", "compositionend"];
    lanes.forEach(name => element.addEventListener(name, keyboardLane, true));
    element.addEventListener("paste", literalLane, true);
    const pointerEvents = ["pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "mousemove", "mouseup", "wheel", "touchstart", "touchmove", "touchend", "touchcancel"];
    pointerEvents.forEach(name => document.addEventListener(name, pointerLane, true));
    const acceptsInput = () => activeRef.current && mounted.current && access.current() && pasteView.current.connected
      && pasteView.current.id === session.id && pasteView.current.terminal === terminal;
    const owner: InputOwner = {session, disposed: false};
    inputOwner.current = owner;
    const output = observeTerminalInput(terminal, (data, userInput) => {
      let value = data;
      const pointerInput = !!pointerInputEvent.current?.eventPhase && !keyboardInputEvent.current?.eventPhase;
      if (userInput && (!acceptsInput() || document.hidden || !document.hasFocus()
        || ((document.activeElement !== terminal.textarea || terminal.textarea?.readOnly) && !literalPaste.current && !pointerInput))) {
        output.reset(); return;
      }
      if (userInput) {
        // DOM dispatch can checkpoint microtasks between capture and xterm's
        // listener. eventPhase identifies the real active source without timing
        // guesses, while retaining the lane for asynchronously committed IME.
        if (!pointerInput && !literalPaste.current && inputLane.current === "keyboard") {
          const state = modifierState.current;
          value = state.shift && !state.ctrl && !state.meta && (data === "\r" || data === "\n")
            ? parseChord("Shift+Enter")
            : modifiedTerminalText(data, state.ctrl, state.meta);
          if (value !== data) output.clear();
          consumeModifiers();
        }
        if (!pointerInput) inputLane.current = null;
      }
      if (literalPaste.current && literalCapture.current) {literalCapture.current.push(value); return;}
      if (session.connected) void writeInput(userInput ? 'terminal-user' : 'terminal-nonuser', value, owner).catch(error => reportError(captureUiError(error)));
    }, acceptsInput, setUnappliedEdit);
    imeInput.current = output;
    setModifierInput(output.available);
    const resizeRemote = ({cols, rows}: {cols: number; rows: number}) => {
      if (session.connected && !owner.disposed && inputOwner.current === owner && mounted.current && access.current())
        void api.resize(session.id, cols, rows).catch(error => reportError(captureUiError(error)));
    };
    // Authoritative Mosh parser resizes never echo back to the server.
    const size = session.moshResize ? session.moshResize.onResizeIntent(resizeRemote) : terminal.onResize(resizeRemote);
    const screen = element.querySelector<HTMLElement>(".xterm-screen");
    const viewport = element.querySelector<HTMLElement>(".xterm-viewport");
    let viewportHeight = viewport?.clientHeight ?? 0;
    // A taller container clamps the DOM viewport before any fit runs. That
    // scroll is layout, not a reader: xterm would otherwise move the reader to
    // the clamp and stop following output. Mosh resizes only after a round trip.
    const clamped = (event: Event) => {
      if (!viewport || event.target !== viewport || viewport.clientHeight === viewportHeight) return;
      viewportHeight = viewport.clientHeight;
      event.stopPropagation();
      syncTerminalViewport(terminal);
    };
    element.addEventListener("scroll", clamped, true);
    const scrolls = keepViewportScrolls(terminal, element);
    const fitTerminal = () => {
      // Keep at least one measured row while the composer yields its remaining room.
      const rowHeight = screen && terminal.rows > 0 ? Math.ceil(screen.clientHeight / terminal.rows) : 0;
      if (rowHeight > 0 && Number.isFinite(rowHeight)) {
        const minimum = `${rowHeight}px`;
        if (element.style.minHeight !== minimum) element.style.minHeight = minimum;
      }
      if (!activeRef.current || element.clientWidth <= 0) return;
      // The composer covers the output; its keyboard and toolbar changes never reach the PTY.
      if (composingRef.current) return;
      // A closed Mosh screen retains its final canonical rows. A later stock
      // fit could discard its bottom rows when the final cursor is above them.
      if (session.moshResize) {
        const proposed = session.connected ? addon.proposeDimensions() : undefined;
        if (proposed) {
          try {session.moshResize.requestSize(proposed.cols, proposed.rows);}
          catch {reportError(t('appUnavailableInThisAppBuild'));}
        }
      } else {
        const buffer = terminal.buffer.active;
        // Stock resize moves scrolled-back history with the cursor.
        const history = buffer.type === 'normal' && buffer.viewportY < buffer.baseY;
        let top = buffer.viewportY;
        // Reflow merges or splits wrapped rows; their logical line start survives.
        if (history && addon.proposeDimensions()?.cols !== terminal.cols) while (top > 0 && buffer.getLine(top)?.isWrapped) top--;
        const anchor = history ? terminal.registerMarker(top - buffer.baseY - buffer.cursorY) : undefined;
        try {addon.fit();
          if (anchor && !anchor.isDisposed && terminal.buffer.active === buffer) terminal.scrollToLine(anchor.line);
        } finally {anchor?.dispose();}
      }
      syncTerminalViewport(terminal);
      if (viewport) viewportHeight = viewport.clientHeight;
    };
    fit.current = fitTerminal;
    const resize = new ResizeObserver(fitTerminal);
    resize.observe(element);
    if (screen) resize.observe(screen);
    fitTerminal();
    focusActivatedTerminal();
    return () => {
      owner.disposed = true;
      if (inputOwner.current === owner) inputOwner.current = null;
      lanes.forEach(name => element.removeEventListener(name, keyboardLane, true));
      element.removeEventListener("paste", literalLane, true);
      element.removeEventListener("scroll", clamped, true); scrolls();
      pointerEvents.forEach(name => document.removeEventListener(name, pointerLane, true));
      resize.disconnect(); imeInput.current = null; output.dispose(); size.dispose(); osc.dispose(); links.dispose(); addon.dispose();
      terminal.attachCustomKeyEventHandler(() => true);
      fit.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    try {applyTerminalTheme(session.terminal, preferences, fontFamilyFor(preferences, fonts));} catch (error) {reportError(String(error));}
    if (active) requestAnimationFrame(() => fit.current?.());
  }, [preferences, fonts, session, active]);

  // Covered output keeps its size and session but leaves focus and the accessibility tree.
  useEffect(() => {container.current?.toggleAttribute('inert', composing);}, [composing]);
  // A carried keyboard moves to this terminal in the commit that shows it, before any frame lets it close.
  useLayoutEffect(() => {if (active && !composing && keyboardCarried()) focusTerminal();}, [active]);
  useEffect(() => {
    if (active) requestAnimationFrame(() => { fit.current?.(); if (composing) focusTerminal(composerInput.current); else focusActivatedTerminal(); });
  }, [active, session, composing]);

  // A soft keyboard opens for focused terminal input; tapping the terminal or the keyboard key still requests it.
  function focusActivatedTerminal() {
    if (mayFocusOnActivation(typing.current)) focusTerminal();
  }

  function focusTerminal(target?: HTMLElement | null) {
    if (!activeRef.current || !session.connected || !mounted.current || !access.current() || document.hidden || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    if (target !== undefined) target?.focus();
    else {imeInput.current?.resume(); session.terminal.focus();}
  }
  // Like xterm's keyboard input, sent keys return the reader to the live screen where the TUI answers them.
  function followLive() {if (session.terminal.options.scrollOnUserInput !== false) session.terminal.scrollToBottom();}
  function sendNamed(key: string, physical?: KeyboardEvent, expectedOwner?:InputOwner) {
    const current=()=>activeRef.current&&session.connected&&mounted.current&&access.current()&&(!expectedOwner||(inputOwner.current===expectedOwner&&!expectedOwner.disposed&&expectedOwner.session.id===session.id&&expectedOwner.session.terminal===session.terminal&&dpadView.current.session===session&&pasteView.current.id===session.id&&pasteView.current.terminal===session.terminal&&!document.querySelector('[role="dialog"][aria-modal="true"]')));
    if (!current()) return false;
    if (document.hidden) {clearModifiers(); repeated.current = true; return false;}
    imeInput.current?.flush();
    if (!current() || document.hidden) return false;
    const state = modifierState.current;
    const prefix = `${state.ctrl || physical?.ctrlKey ? "Ctrl+" : ""}${state.meta || physical?.altKey ? "Alt+" : ""}${((repeatShift.current ?? state.shift) && key.length > 1) || physical?.shiftKey ? "Shift+" : ""}`;
    try {
      const sequence = key.length === 1 ? modifiedTerminalText(key, state.ctrl || !!physical?.ctrlKey, state.meta || !!physical?.altKey) : parseChord(`${prefix}${key}`);
      // Application cursor-key mode (DECCKM) sends the unmodified cursor keys as SS3 sequences, as xterm does.
      const input = session.terminal.modes?.applicationCursorKeysMode ? sequence.replace(/^\x1b\[([ABCDHF])$/, "\x1bO$1") : sequence;
      void writeInput('named-key', input,expectedOwner).catch(error => reportError(captureUiError(error)));
    }
    catch (error) {reportError(error instanceof LocalUiError ? error : String(error)); return false;}
    followLive();
    consumeModifiers();
    focusTerminal();return true;
  }
  sendNamedRef.current = sendNamed;
  function sendKey(key: string) {
    const named: Record<string, string> = {"\x1b":"Escape", "\t":"Tab", "\r":"Enter", "\x7f":"Backspace", "\x1b[D":"Left", "\x1b[A":"Up", "\x1b[B":"Down", "\x1b[C":"Right"};
    sendNamed(named[key] ?? key);
  }
  function cycleModifier(key: "ctrl" | "meta") {
    const state = modifierState.current;
    if (key === "ctrl") {const locked = state.ctrl && !state.ctrlLocked; const enabled = !state.ctrlLocked; state.ctrl = enabled; state.ctrlLocked = locked; setCtrl(enabled); setCtrlLocked(locked);}
    else {const locked = state.meta && !state.metaLocked; const enabled = !state.metaLocked; state.meta = enabled; state.metaLocked = locked; setMeta(enabled); setMetaLocked(locked);}
  }
  async function copy(text: string) {
    if (!mounted.current || !access.current()) return;
    // An OS clipboard write already dispatched cannot be undone on lock.
    try { await navigator.clipboard.writeText(text); }
    catch { if (mounted.current && access.current()) reportError(new LocalUiError('terminalCopyUnavailable')); }
  }
  async function openLink() {
    if (!link || openingLink) return;
    const selected = link;
    setOpeningLink(true);
    try { await api.openWebUrl(selected); setLink(current => current === selected ? null : current); }
    catch (error) { reportError(typeof error === 'string' ? error : new LocalUiError('terminalBrowserUnavailable')); }
    finally { setOpeningLink(false); }
  }
  async function paste() {
    if (!active || !session.connected || !mounted.current || !access.current() || pasteRead.current) return;
    const read = new AbortController(); pasteRead.current = read;
    setPasteBusy(true);
    const current = () => mounted.current && access.current() && !read.signal.aborted && pasteView.current.active && pasteView.current.connected
      && pasteView.current.id === session.id && pasteView.current.terminal === session.terminal;
    try {
      const text = await readClipboardText(read.signal);
      // The retained terminal may now have a fresh onData handler after unlock.
      if (!current()) return;
      checkPasteSize(text, session.terminal.modes?.bracketedPasteMode);
      pasteLiteral(text); focusTerminal();
    }
    catch { if (current()) reportError(new LocalUiError('terminalPasteUnavailable')); }
    finally {
      if (pasteRead.current === read) {
        pasteRead.current = null;
        if (mounted.current) setPasteBusy(false);
      }
    }
  }
  function search(direction: number) {
    if (!query) return;
    const buffer = session.terminal.buffer.active;
    const start = searchLine.current < 0 ? (direction > 0 ? -1 : buffer.length) : searchLine.current;
    for (let offset = 1; offset <= buffer.length; offset++) {
      const line = (start + offset * direction + buffer.length * 2) % buffer.length;
      const text = buffer.getLine(line)?.translateToString(true) ?? "";
      const column = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (column >= 0) {
        searchLine.current = line;
        session.terminal.scrollToLine(line);
        session.terminal.select(0, line, text.length);
        setSearchStatus(line + 1);
        return;
      }
    }
    setSearchStatus("none");
  }
  function sendChord(keys: string | undefined): boolean {
    const current = () => mounted.current && access.current() && activeRef.current && session.connected;
    if (!current()) return false;
    if (!keys) {reportError(new LocalUiError('terminalChordRequired')); return false;}
    try {
      const steps = parseChordSteps(keys);
      imeInput.current?.flush();
      void writeInput('chord', steps).catch(error => {if (current()) reportError(errorMessage(error));});
      followLive();
      return true;
    } catch (error) {if (current()) reportError(error instanceof LocalUiError?error:errorMessage(error)); return false;}
  }
  function navigationReady() {
    return mounted.current && access.current() && activeRef.current && session.connected && !composingIme() && !session.terminal.hasSelection();
  }
  function navigateZellij(name: string, type: MultiplexerAction) {
    imeInput.current?.flush();
    zellijBusy.current = true;
    void api.zellijNavigate(session.id, name, type)
      .catch(error => {if (mounted.current && access.current() && activeRef.current && session.connected) reportError(errorMessage(error));})
      .finally(() => {zellijBusy.current = false;});
  }
  /** Tab, pane and zoom actions reach the attached multiplexer: Zellij through its CLI, tmux and Herdr through their prefix keys. */
  function runMultiplexer(action: MultiplexerAction) {
    if (!navigationReady()) return;
    if (!multiplexer || !session.attached) {reportError(new LocalUiError('terminalMultiplexerRequired')); return;}
    if (multiplexer === 'herdr' && herdrNavigationOnly && action === 'zoomPane') {reportError(new LocalUiError('muxLimitedHerdr')); return;}
    if (multiplexer === 'zellij') {if (!zellijBusy.current) navigateZellij(session.attached.name, action); return;}
    const prefix = storedPrefix(multiplexer);
    if (!validPrefix(prefix)) {reportError(new LocalUiError('muxShortcutInvalid')); return;}
    imeInput.current?.flush();
    void writeInput('gesture', multiplexerSteps(multiplexer, action, prefix)).catch(error => reportError(captureUiError(error)));
    followLive();
  }
  function runGesture(requested: GestureAction, slot?: GestureSlot, keys = slot ? preferences.gestureChords[slot] : undefined) {
    const action = resolveGesture(requested, slot, multiplexer, session.local);
    if (isMultiplexerAction(action)) {runMultiplexer(action); return;}
    const zellijActions = {nextZellijTab:'nextTab',previousZellijTab:'previousTab',nextZellijPane:'nextPane',previousZellijPane:'previousPane'} as const;
    if (Object.hasOwn(zellijActions, action)) {
      if (!navigationReady() || zellijBusy.current) return;
      if (session.local || session.attached?.kind !== 'zellij') {reportError(new LocalUiError('terminalZellijRequired')); return;}
      navigateZellij(session.attached.name, zellijActions[action as keyof typeof zellijActions]);
      return;
    }
    if (action === "find") {setSearching(true); requestAnimationFrame(() => focusTerminal(searchInput.current));}
    else if (action === "compose") setComposing(true);
    else if (action === "keyboard") focusTerminal();
    else if (action === "hideKeyboard") session.terminal.blur();
    else if (action === "paste") void paste();
    else if (action === "copy") {const text = session.terminal.getSelection(); if (text) void copy(text);}
    else if (action === "nextSession" || action === "previousSession" || action === "openAgents" || action === "openWorkspaces") window.dispatchEvent(new CustomEvent("lazysh-terminal-action", {detail: {sessionId: session.id, action}}));
    else if (action === "custom") sendChord(keys);
    else {
      const keys = ({left: "\x1b[D", right: "\x1b[C", pageUp: "\x1b[5~", pageDown: "\x1b[6~", escape: "\x1b", tab: "\t", backspace: "\x7f", interrupt: "\x03", none: ""} as Partial<Record<GestureAction,string>>)[action];
      if (keys && session.connected) {imeInput.current?.flush(); void writeInput('gesture', keys).catch(error => reportError(captureUiError(error))); followLive();}
    }
  }
  function cancelTaps() {
    if (taps.current?.timer) clearTimeout(taps.current.timer);
    taps.current = null;
  }
  function tap(x: number, y: number) {
    if (preferences.bodyGestures.tap === "none" && preferences.bodyGestures.doubleTap === "none" && preferences.bodyGestures.tripleTap === "none") return;
    const previous = taps.current;
    const count = previous && Date.now() - previous.when <= 350 && Math.hypot(x - previous.x, y - previous.y) < 24 ? previous.count + 1 : 1;
    cancelTaps();
    const slot = count >= 3 ? "tripleTap" : count === 2 ? "doubleTap" : "tap";
    const perform = () => {
      taps.current = null;
      if (activeRef.current && !composingIme() && !session.terminal.hasSelection()) runGesture(preferences.bodyGestures[slot], slot);
    };
    if (count >= 3 || (count === 2 && preferences.bodyGestures.tripleTap === "none") || (count === 1 && preferences.bodyGestures.doubleTap === "none" && preferences.bodyGestures.tripleTap === "none")) perform();
    else taps.current = {count, x, y, when: Date.now(), timer: setTimeout(perform, 350)};
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!customTouch || event.pointerType !== "touch" || composingIme() || session.terminal.hasSelection()) return;
    pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (pointers.current.size === 1) {
      if (taps.current?.timer) clearTimeout(taps.current.timer);
      press.current = {id: event.pointerId, x: event.clientX, y: event.clientY, when: Date.now(), moved: false};
    }
    if (pointers.current.size === 2) {
      press.current = null; cancelTaps();
      const [a, b] = [...pointers.current.values()];
      gesture.current = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), fontSize: preferences.fontSize, zoomed: false, moved: new Set()};
    } else if (pointers.current.size > 2) gesture.current = null;
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) {press.current.moved = true; cancelTaps();}
    if (!gesture.current || pointers.current.size !== 2) return;
    if (composingIme() || session.terminal.hasSelection()) {gesture.current = null; return;}
    gesture.current.moved.add(event.pointerId);
    // Wait for both touches so a parallel swipe cannot look like a one-sided pinch.
    if (gesture.current.moved.size < 2) return;
    gesture.current.moved.clear();
    const [a, b] = [...pointers.current.values()];
    const scale = Math.hypot(a.x - b.x, a.y - b.y) / gesture.current.distance;
    if (pinch(scale, gesture.current)) {
      gesture.current.zoomed = true;
      if (event.cancelable) event.preventDefault();
    }
  }
  /** In a multiplexer the pinch runs its configured action once; elsewhere it resizes terminal text. */
  function pinch(scale: number, start: NonNullable<typeof gesture.current>) {
    const resolved = multiplexer ? resolveGesture(preferences.bodyGestures.pinch, "pinch", multiplexer) : "fontSize";
    if (resolved === "fontSize") {
      if (!preferences.pinchZoom || Math.abs(scale - 1) < pinchResize) return false;
      const fontSize = Math.max(10, Math.min(32, Math.round(start.fontSize * scale)));
      if (fontSize !== preferences.fontSize) {
        try {savePreferences({...preferences, fontSize});} catch {reportError(new LocalUiError('terminalFontSaveFailed'));}
      }
      return true;
    }
    if (resolved === "none" || Math.abs(scale - 1) < pinchAction) return false;
    if (!start.zoomed) runGesture(resolved, "pinch");
    return true;
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = gesture.current;
    const single = press.current;
    if (single?.id === event.pointerId && pointers.current.size === 1 && !composingIme() && !session.terminal.hasSelection()) {
      const dx = event.clientX - single.x, dy = event.clientY - single.y;
      if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        const slot = dx < 0 ? "swipeLeft" : "swipeRight";
        runGesture(preferences.bodyGestures[slot], slot);
      } else if (!single.moved && Math.hypot(dx, dy) <= 10 && Date.now() - single.when <= 500) tap(event.clientX, event.clientY);
      else cancelTaps();
    }
    if (start && pointers.current.size === 2 && !start.zoomed && !composingIme() && !session.terminal.hasSelection()) {
      pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
      const [a, b] = [...pointers.current.values()];
      const dx = (a.x + b.x) / 2 - start.x, dy = (a.y + b.y) / 2 - start.y;
      const scale = Math.hypot(a.x - b.x, a.y - b.y) / start.distance;
      if (!pinch(scale, start) && Math.max(Math.abs(dx), Math.abs(dy)) >= 60) {
        const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        const slot = {left: "twoLeft", right: "twoRight", up: "twoUp", down: "twoDown"}[direction] as GestureSlot;
        runGesture(preferences.gestures[direction], slot);
      }
    }
    pointers.current.delete(event.pointerId);
    press.current = null;
    gesture.current = null;
  }
  function dpadArrow(direction:DpadDirection) {
    const label={left:'terminalDpadLeft',up:'terminalDpadUp',down:'terminalDpadDown',right:'terminalDpadRight'} as const;
    return <button key={direction} disabled={!session.connected} data-dpad-direction={direction} aria-label={t(label[direction])} style={dpadDirection===direction?{outline:'1px solid var(--theme-accent)'}:undefined} onClick={()=>{if(inputOwner.current)sendNamed(direction[0].toUpperCase()+direction.slice(1),undefined,inputOwner.current);}}>{labels[direction]}</button>;
  }
  function toolbarKey(key: ToolbarKey) {
    const modifier = key === "ctrl" || key === "meta" || key === "altgr" || key === "shift";
    const locked = key === "ctrl" ? ctrlLocked : key === "meta" ? metaLocked : key === "altgr" ? ctrlLocked && metaLocked : false;
    const pressed = key === "ctrl" ? ctrl : key === "meta" ? meta : key === "shift" ? shift : key === "altgr" ? ctrl && meta : key === "dpad" ? dpadOpen : undefined;
    const action = () => {
      if (modifier) {
        if (!activeRef.current || !session.connected || !mounted.current || !access.current() || document.hidden) return;
        if (key === "shift" && modifierState.current.shift) {modifierState.current.shift = false; setShift(false); return;}
        imeInput.current?.settle(); imeComposing.current = false; endTextComposition();
      }
      if (key === "ctrl" || key === "meta") cycleModifier(key);
      else if (key === "altgr") {const both = modifierState.current.ctrl && modifierState.current.meta; if (both || !modifierState.current.ctrl) cycleModifier("ctrl"); if (both || !modifierState.current.meta) cycleModifier("meta");}
      else if (key === "shift") {modifierState.current.shift = !shift; setShift(!shift);}
      else if (key === "paste") {if (clipboardPlatform.phase === "ready") void paste(); else if (active && mounted.current && access.current()) void clipboardPlatform.retry();}
      else if (key === "attach") {if (activeRef.current && session.connected && access.current()) onOpenAttachments?.();}
      else if (key === "keyboard") {if (document.activeElement === session.terminal.textarea) session.terminal.blur(); else focusTerminal();}
      else if (key === "dpad") {setDpadOpen(!dpadOpen); setComposing(false);}
      else if (key === "agents" || key === "workspaces") runGesture(toolbarNavigationActions[key]);
      else sendKey(sequences[key] ?? key);
      if (modifier) focusTerminal();
    };
    const alternate = toolbarKeyHasAlternate(key) ? preferences.toolbarAlternates?.[key] : undefined;
    const repeatable = !alternate && !modifier && key !== "paste" && key !== "attach" && key !== "keyboard" && key !== "dpad" && !Object.hasOwn(toolbarNavigationActions, key);
    const release = () => {stopRepeat(); releaseHold();};
    const Icon = toolbarIcons[key];
    // Icons and arrows carry no text, and a locked modifier shows its lock as an icon, so each names itself for assistive technology.
    const name = key === "attach" ? t("terminalAttach") : key === "keyboard" ? t("terminalKeyboardToggle")
      : labels[key] ? t(arrowLabelKeys[key as keyof typeof arrowLabelKeys]) : Icon ? toolbarKeyLabel(key) : locked ? `${toolbarKeyLabel(key)} · ${t("terminalLock")}` : undefined;
    return <button key={key} disabled={(!session.connected && key !== "dpad") || (modifier && !modifierInput) || (key === "attach" && (session.local || !onOpenAttachments)) || (key === "agents" && session.local) || (key === "paste" && (pasteBusy || clipboardPlatform.phase === "loading"))}
      aria-busy={key === "paste" ? pasteBusy : undefined} aria-pressed={pressed} aria-label={name}
      title={modifier && !modifierInput ? t("terminalModifiersUnavailable") : alternate ? t("terminalKeyAlternate", {action: alternate.keys ?? t(gestureLabelKeys[alternate.action])}) : undefined}
      data-alternate={alternate ? "" : undefined}
      onPointerDown={event => {
        if (key !== "attach") event.preventDefault();
        if (alternate) {
          releaseHold(); held.current = null;
          if (event.button === 0) {event.currentTarget.setPointerCapture?.(event.pointerId); holdAlternate(key, alternate);}
        }
        else if (repeatable) {repeated.current = false; event.currentTarget.setPointerCapture?.(event.pointerId); startRepeat(action);}
      }}
      onContextMenu={alternate ? event => {event.preventDefault(); fireAlternate(key, alternate);} : undefined}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} onBlur={release}
      onClick={event => {
        if (alternate) {if (event.detail === 0 || !(held.current?.key === key && held.current.fired)) action(); held.current = null;}
        else if (!repeatable || !repeated.current || event.detail === 0) action();
      }}>
      {Icon ? <Icon size={16} aria-hidden="true" /> : labels[key] ?? (key === "paste" ? t(clipboardPlatform.phase === "ready" ? "terminalPaste" : clipboardPlatform.phase === "loading" ? "clipboardChecking" : "clipboardRetry") : key === "dpad" ? t("terminalDpad") : toolbarKeyLabel(key))}
      {locked && <Lock className="terminal-key-lock" size={9} aria-hidden="true" />}
    </button>;
  }
  /** The toolbar pages after the keys: Find and Copy, then the saved snippets and chords when there are any. */
  function toolbarExtraPages(): ToolbarPage[] {
    const hold = (event: ReactPointerEvent<HTMLButtonElement>) => event.preventDefault();
    const pages: ToolbarPage[] = [{id: "tools", content: <div className="terminal-keys-list">
      <button type="button" onPointerDown={hold} onClick={() => {setSearching(!searching); requestAnimationFrame(() => focusTerminal(searchInput.current));}}>{t('terminalFind')}</button>
      <button type="button" onPointerDown={hold} onClick={() => {const text = session.terminal.getSelection(); if (text) void copy(text); else reportError(new LocalUiError('terminalSelectFirst'));}}>{t('terminalCopy')}</button>
    </div>}];
    if (preferences.snippets.length || preferences.chords.length) pages.push({id: "snippets", content: <div className="terminal-keys-list">
      {preferences.snippets.map((snippet, index) => <button key={`snippet-${index}`} type="button" disabled={!session.connected} onPointerDown={hold} onClick={() => {setDraft(snippet.text); setDraftAttachments([]); setComposing(true);}}>{snippet.label}</button>)}
      {preferences.chords.map((chord, index) => <button key={`chord-${index}`} type="button" title={chord.keys} disabled={!session.connected} onPointerDown={hold} onClick={() => {if (sendChord(chord.keys)) focusTerminal();}}>{chord.label}</button>)}
    </div>});
    return pages;
  }
  const submittingDraft = useRef(false);
  /** Send pastes the draft and presses Enter; Insert only pastes it. The draft and composer stay when the write fails. */
  async function submitDraft(enter: boolean) {
    const text = draftRef.current;
    if (submittingDraft.current || !session.connected || !composerDraftReady(text, enter)) return;
    submittingDraft.current = true;
    try {
      if (!await pasteLiteral(expandComposerDraft(text, liveAttachmentsRef.current), enter) || !mounted.current || draftRef.current !== text) return;
      setDraft(""); setDraftAttachments([]); setComposing(false); focusTerminal();
    } finally {submittingDraft.current = false;}
  }
  const attachFromComposer = composing && !session.local && session.connected && !!onOpenAttachments;
  const keyRows = visibleToolbarRows(toolbarRows(preferences.toolbar), key => key !== "attach" || !attachFromComposer);
  const controls = <div className={`terminal-actions${controlsTarget ? "" : " terminal-actions-fallback"}`}>
    <button type="button" className="icon-button" title={t('terminalCompose')} aria-label={t('terminalCompose')} aria-pressed={composing} onClick={() => setComposing(!composing)}><SquarePen size={18} aria-hidden="true" /></button>
    <button type="button" className="icon-button" title={toolbarVisible ? t("terminalHideKeys") : t("terminalShowKeys")} aria-label={toolbarVisible ? t("terminalHideKeys") : t("terminalShowKeys")} onClick={() => setToolbarOverride(!toolbarVisible)} aria-expanded={toolbarVisible}>{toolbarVisible ? <KeyboardOff size={18} aria-hidden="true" /> : <Keyboard size={18} aria-hidden="true" />}</button>
  </div>;
  return <div ref={pane} className="terminal-pane" style={{display: active ? "flex" : "none"}} onFocus={() => {typing.current = false;}}>
    {(fonts.selection.primary || fonts.selection.cjk) && fonts.warnings.map(warning => <div className="session-notice" role="note" key={fontWarningKey(warning)}>{fontWarningText(warning)}</div>)}
    {notice ?? (!session.connected && <div className="session-notice" role="status">{t("terminalEnded",{details:session.message ? ` · ${session.message}` : ""})}</div>)}
    <div className="sr-only" role="status">{unappliedEdit ? t('terminalEditAnnouncement') : ""}</div>
    {unappliedEdit && <details ref={editReview} className="terminal-edit-review">
      <summary>{t('terminalEditNotSent')}</summary>
      <p>{t('terminalEditContext')}</p>
      <pre>{unappliedEdit.text}</pre>
      {unappliedEdit.truncated && <p role="status">{t('terminalEditTruncated')}</p>}
      <button type="button" disabled={unappliedEdit.truncated} onClick={() => {
        if (activeRef.current && session.connected && !document.hidden && document.hasFocus()) void copy(unappliedEdit.text);
      }}>{t('terminalEditCopy')}</button>
      <button type="button" onClick={() => {imeInput.current?.dismiss(); focusTerminal();}}>{t('terminalEditDismiss')}</button>
    </details>}
    {clipboard !== null && <div className="terminal-consent" role="region" aria-label={t('terminalClipboardRegion')}>
      <p>{t("terminalClipboardPrompt",{count:clipboard.length,characters:formatNumber(clipboard.length)})}</p>
      <pre>{clipboard.slice(0, 500)}{clipboard.length > 500 ? "…" : ""}</pre>
      <button onClick={() => { void copy(clipboard); setClipboard(null); pendingClipboard.current = false; }}>{t('terminalAllowCopy')}</button>
      <button onClick={() => { setClipboard(null); pendingClipboard.current = false; }}>{t('terminalDeny')}</button>
    </div>}
    {link && <div className="terminal-consent" role="region" aria-label={t('terminalLinkRegion')}>
      <p>{link}</p><button disabled={openingLink} onClick={() => void openLink()}>{openingLink ? t('terminalOpening') : t('terminalOpenBrowser')}</button><button onClick={() => void copy(link)}>{t('terminalCopyUrl')}</button><button onClick={() => setLink(null)}>{t('terminalDismissLink')}</button>
    </div>}
    {searching && <form className="terminal-search" onSubmit={event => {event.preventDefault(); search(1);}}>
      <input ref={searchInput} aria-label={t('terminalSearch')} maxLength={256} value={query} onChange={event => {setQuery(event.target.value); searchLine.current = -1; setSearchStatus(null);}} />
      <button>{t('terminalNext')}</button><button type="button" onClick={() => search(-1)}>{t('terminalPrevious')}</button><button type="button" onClick={() => {setSearching(false); focusTerminal();}}>{t('terminalCloseSearch')}</button>
      <span role="status">{typeof searchStatus === "number" ? t("terminalMatch",{line:formatNumber(searchStatus)}) : searchStatus === "none" ? t("terminalNoMatch") : ""}</span>
    </form>}
    <div className="terminal-stage">
    {pull && pullAction !== "none" && <div className="terminal-pull" role="status" data-depth={pull}>{t("terminalPullRelease", {action: pullAction === "custom" ? preferences.gestureChords[pull] ?? "" : t(gestureLabelKeys[pullAction])})}</div>}
    <div ref={container} className={`terminal-canvas${preferences.screenReader ? " terminal-screen-reader" : ""}`} style={{touchAction: preferences.screenReader ? "auto" : "none"}} aria-label={t("terminalCanvas",{name:session.name})} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => {pointers.current.clear(); gesture.current = null; press.current = null; cancelTaps();}} onCompositionStartCapture={() => {imeComposing.current = true; pointers.current.clear(); gesture.current = null; press.current = null; cancelTaps();}} onCompositionEndCapture={() => {imeComposing.current = false;}} />
    {active && selectionTools && createPortal(<TerminalSelectionTools terminal={session.terminal} handles={selectionTools.handles}
      onCopy={text => void copy(text)} onDone={() => setSelectionTools(null)} />, document.body)}
    {composing && <TerminalComposer value={draft} onChange={setDraft} textareaRef={composerInput} attachments={liveAttachments}
      disabled={!session.connected} sendEnter={preferences.composerSendEnter}
      onSubmit={enter => void submitDraft(enter)}
      onClose={() => setComposing(false)}
      onAttach={attachFromComposer ? () => {if (activeRef.current && mounted.current && access.current()) onOpenAttachments?.('composer');} : undefined} />}
    </div>
    {active && (controlsTarget ? createPortal(controls, controlsTarget) : controls)}
    {ctrlLocked && <div className="sr-only" role="status">{t('terminalControlLocked')}</div>}
    {dpadEnabled && <div ref={dpadElement} className="terminal-dpad" role="group" data-edge-gestures-ignore="" aria-label={t('terminalDpadGroup')} style={{touchAction:'none'}} onContextMenu={event=>event.preventDefault()} onPointerDown={dpadDown} onPointerMove={dpadMove} onLostPointerCapture={event=>{if(dpad.current.pointers.has(event.pointerId))cancelDpad();}} onClickCapture={event=>{
      if(document.querySelector('[role="dialog"][aria-modal="true"]')||(event.detail>0&&dpad.current.suppressClick)){cancelDpad();event.preventDefault();event.stopPropagation();return;}
      if(event.detail===0)cancelDpad();
    }}>
      {preferences.dpadCorners.left === "none" ? <span /> : <button disabled={!session.connected} aria-label={t('terminalDpadLeftCorner')} title={preferences.gestureChords.cornerLeft ?? t(gestureLabelKeys[preferences.dpadCorners.left])} onClick={() => runGesture(preferences.dpadCorners.left, "cornerLeft")}>{preferences.dpadCorners.left === "interrupt" ? "^C" : preferences.dpadCorners.left === "backspace" ? "⌫" : "1"}</button>}
      {dpadArrow('up')}
      {preferences.dpadCorners.right === "none" ? <span /> : <button disabled={!session.connected} aria-label={t('terminalDpadRightCorner')} title={preferences.gestureChords.cornerRight ?? t(gestureLabelKeys[preferences.dpadCorners.right])} onClick={() => runGesture(preferences.dpadCorners.right, "cornerRight")}>{preferences.dpadCorners.right === "backspace" ? "⌫" : preferences.dpadCorners.right === "interrupt" ? "^C" : "2"}</button>}
      {(['left','down','right'] as const).map(dpadArrow)}
    </div>}
    {toolbarVisible && <div className="terminal-keys" aria-label={t('terminalKeys')} data-rows="" style={{"--toolbar-columns": toolbarColumns(keyRows), "--toolbar-rows": keyRows.length, "--terminal-key-height": `${preferences.toolbarKeyHeight ?? toolbarKeyHeights.default}px`} as CSSProperties}>
      <ToolbarPages repeats={repeatStarts} pages={[{id: "keys", content: keyRows.map((row, rowIndex) => <div key={rowIndex} className="terminal-keys-row">{row.map((key, column) => key === "gap" ? <span key={`gap-${column}`} aria-hidden="true" /> : toolbarKey(key))}</div>)}, ...toolbarExtraPages()]} />
    </div>}
  </div>;
}
