import {t,useUi,formatNumber} from './i18n/core';
import {LocalUiError,type UiErrorCause} from './i18n/localError';
import { checkPasteSize, readClipboardText, useClipboardPlatform } from './deviceClipboard';
import { subscribeAccess, useMountedAccess, useProtectedApi } from './access';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Keyboard, KeyboardOff, Paperclip, SquarePen } from "lucide-react";
import { api as nativeApi } from "./bridge";
import { decodeClipboardRequest, gestureLabelKeys, parseChord, parseChordSteps, savePreferences, toolbarKeyLabel, usePreferences, type GestureAction, type GestureSlot, type ToolbarKey } from "./preferences";
import { modifiedTerminalText, observeTerminalInput, type LiveSession } from "./terminal";
import { applyTerminalTheme } from "./terminalBold";
import { fontFamilyFor, fontWarningKey, fontWarningText, useDeviceFonts } from "./fonts";
import { errorMessage } from "./SessionTools";
import "@xterm/xterm/css/xterm.css";

const sequences: Partial<Record<ToolbarKey, string>> = {esc: "\x1b", tab: "\t", c: "c", d: "d", enter: "\r", backspace: "\x7f", left: "\x1b[D", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C"};
const arrowLabelKeys = {left:"terminalArrowLeft",up:"terminalArrowUp",down:"terminalArrowDown",right:"terminalArrowRight"} as const;
const labels: Partial<Record<ToolbarKey, string>> = {left: "←", up: "↑", down: "↓", right: "→"};

export function terminalWebUrl(value: string): string | undefined {
  if (value.length > 4096 || /[\s\x00-\x1f\x7f-\x9f\\]/.test(value) || !/^https?:\/\//i.test(value)) return;
  const authority = value.split('://')[1].split(/[/?#]/)[0];
  if (!authority || authority.includes('@')) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password && url.href.length <= 4096) return url.href;
  } catch { /* Ignore malformed remote links. */ }
}

export default function TerminalPane({ session, active, reportError, onOpenAttachments }: {
  session: LiveSession;
  active: boolean;
  reportError: (message: UiErrorCause) => void;
  onOpenAttachments?: () => void;
}) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const { access, mounted } = useMountedAccess();
  const container = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
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
  const pointerInputEvent = useRef<Event | null>(null);
  const keyboardInputEvent = useRef<Event | null>(null);
  const repeated = useRef(false);
  const repeat = useRef<{delay?: ReturnType<typeof setTimeout>; timer?: ReturnType<typeof setInterval>}>({});
  function stopRepeat() {clearTimeout(repeat.current.delay); clearInterval(repeat.current.timer); repeat.current = {};}
  function clearModifiers() {setCtrl(false); setCtrlLocked(false); setMeta(false); setMetaLocked(false); setShift(false); modifierState.current = {ctrl:false, ctrlLocked:false, meta:false, metaLocked:false, shift:false}; inputLane.current = null; pointerInputEvent.current = null; keyboardInputEvent.current = null; stopRepeat();}
  function consumeModifiers() {const state = modifierState.current; if (!state.ctrlLocked) {state.ctrl = false; setCtrl(false);} if (!state.metaLocked) {state.meta = false; setMeta(false);}}
  function pasteLiteral(text: string) {literalPaste.current = true; try {session.terminal.paste(text);} finally {literalPaste.current = false;}}
  const sendNamedRef = useRef<(key: string, physical?: KeyboardEvent) => void>(() => {});
  const [clipboard, setClipboard] = useState<string | null>(null);
  const pendingClipboard = useRef(false);
  const pasteRead = useRef<AbortController | null>(null);
  const clipboardPlatform = useClipboardPlatform();
  const [pasteBusy, setPasteBusy] = useState(false);
  const pasteView = useRef({active, connected: session.connected, id: session.id, terminal: session.terminal});
  pasteView.current = {active, connected: session.connected, id: session.id, terminal: session.terminal};
  useEffect(() => () => { pasteRead.current?.abort(); }, [session.id, session.terminal, session.connected, active]);
  const [link, setLink] = useState<string | null>(null);
  const [openingLink, setOpeningLink] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchLine = useRef(-1);
  const [searchStatus, setSearchStatus] = useState<number | "none" | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [toolbarOverride, setToolbarOverride] = useState<boolean | null>(null);
  const [desktopPointer, setDesktopPointer] = useState(false);
  const imeComposing = useRef(false);
  const pointers = useRef(new Map<number, {x: number; y: number}>());
  const press = useRef<{id: number; x: number; y: number; when: number; moved: boolean} | null>(null);
  const taps = useRef<{count: number; when: number; x: number; y: number; timer?: ReturnType<typeof setTimeout>} | null>(null);
  const gesture = useRef<{x: number; y: number; distance: number; fontSize: number; zoomed: boolean; moved: Set<number>} | null>(null);
  const toolbarVisible = toolbarOverride ?? !(preferences.autoHideToolbar && desktopPointer);
  const customTouch = !preferences.screenReader && (preferences.pinchZoom || Object.values(preferences.gestures).some(action => action !== "none") || Object.values(preferences.bodyGestures).some(action => action !== "none"));

  useEffect(() => subscribeAccess(() => {if (!access.current()) clearModifiers();}), []);
  useEffect(() => {if (!active || !session.connected || !toolbarVisible) clearModifiers(); return stopRepeat;}, [active, session.connected, toolbarVisible, session.id]);
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

  useEffect(() => {
    if (composing && active && draft) composerInput.current?.focus();
  }, [composing, active, draft]);

  useEffect(() => {
    const element = container.current;
    if (!element || preferences.screenReader) return;
    let scroll: {x: number; y: number; lastY: number; active: boolean} | null = null;
    const start = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      scroll = point ? {x: point.clientX, y: point.clientY, lastY: point.clientY, active: false} : null;
    };
    const end = () => {scroll = null;};
    const multitouch = (event: TouchEvent) => {
      if (!activeRef.current || session.terminal.hasSelection()) {end(); return;}
      if (event.touches.length === 1) {
        const point = event.touches[0];
        if (scroll) {
          const dx = point.clientX - scroll.x, dy = point.clientY - scroll.y;
          if (scroll.active || (Math.abs(dy) >= 10 && Math.abs(dy) > Math.abs(dx) * 1.5)) {
            const deltaY = scroll.lastY - point.clientY;
            scroll.active = true; scroll.lastY = point.clientY;
            press.current = null; cancelTaps();
            // xterm's wheel path also reports mouse scrolling to Herdr/other full-screen apps.
            session.terminal.element?.dispatchEvent(new WheelEvent('wheel', {
              bubbles: true, cancelable: true, clientX: point.clientX, clientY: point.clientY, deltaY,
            }));
            event.stopPropagation();
            if (event.cancelable) event.preventDefault();
            return;
          }
        }
        if (imeComposing.current) {end(); return;}
        const start = press.current;
        if (!start) return;
        const dx = event.touches[0].clientX - start.x, dy = event.touches[0].clientY - start.y;
        const action = preferences.bodyGestures[dx < 0 ? "swipeLeft" : "swipeRight"];
        if (action === "none" || Math.abs(dx) < 16 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      } else {end(); if (imeComposing.current || event.touches.length !== 2 || !customTouch) return;}
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    };
    element.addEventListener('touchstart', start, {capture: true, passive: true});
    element.addEventListener("touchmove", multitouch, {capture: true, passive: false});
    element.addEventListener('touchend', end, {capture: true});
    element.addEventListener('touchcancel', end, {capture: true});
    return () => {
      element.removeEventListener('touchstart', start, {capture: true});
      element.removeEventListener('touchmove', multitouch, {capture: true});
      element.removeEventListener('touchend', end, {capture: true});
      element.removeEventListener('touchcancel', end, {capture: true});
    };
  }, [customTouch, preferences.screenReader, session.id, preferences.bodyGestures]);

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
    const addon = new FitAddon();
    fit.current = addon;
    terminal.loadAddon(addon);
    const links = new WebLinksAddon((_event, uri) => {
      const url = terminalWebUrl(uri);
      if (url) setLink(url);
    });
    terminal.loadAddon(links);
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
        requestAnimationFrame(() => searchInput.current?.focus());
        return false;
      }
      const state = modifierState.current;
      if (event.type === "keydown" && !event.isComposing && !event.metaKey && !event.getModifierState?.("AltGraph") && (state.ctrl || state.meta) && /^[ -~]$/.test(event.key) && !(event.ctrlKey && (/^v$/i.test(event.key) || (event.shiftKey && /^c$/i.test(event.key))))) {
        event.preventDefault(); sendNamedRef.current(event.key === " " ? "Space" : event.key, event); return false;
      }
      const named = {ArrowLeft:"Left", ArrowRight:"Right", ArrowUp:"Up", ArrowDown:"Down", Escape:"Escape", Tab:"Tab", Enter:"Enter", Backspace:"Backspace", Home:"Home", End:"End", PageUp:"PageUp", PageDown:"PageDown", Insert:"Insert", Delete:"Delete"} as Record<string,string>;
      if (event.type === "keydown" && !event.isComposing && (state.ctrl || state.meta || state.shift) && (named[event.key] || /^F(?:[1-9]|1[0-2])$/.test(event.key))) {
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
    const output = observeTerminalInput(terminal, (data, userInput) => {
      let value = data;
      if (userInput) {
        // DOM dispatch can checkpoint microtasks between capture and xterm's
        // listener. eventPhase identifies the real active source without timing
        // guesses, while retaining the lane for asynchronously committed IME.
        const pointerInput = !!pointerInputEvent.current?.eventPhase && !keyboardInputEvent.current?.eventPhase;
        if (!pointerInput && !literalPaste.current && inputLane.current === "keyboard") {
          const state = modifierState.current;
          value = modifiedTerminalText(data, state.ctrl, state.meta); consumeModifiers();
        }
        if (!pointerInput) inputLane.current = null;
      }
      if (session.connected) void api.write(session.id, value).catch(error => reportError(String(error)));
    });
    setModifierInput(output.available);
    const size = terminal.onResize(({ cols, rows }) => {
      if (session.connected) void api.resize(session.id, cols, rows).catch(error => reportError(String(error)));
    });
    const screen = element.querySelector<HTMLElement>(".xterm-screen");
    const fitTerminal = () => {
      // Keep at least one measured row while the composer yields its remaining room.
      const rowHeight = screen && terminal.rows > 0 ? Math.ceil(screen.clientHeight / terminal.rows) : 0;
      if (rowHeight > 0 && Number.isFinite(rowHeight)) {
        const minimum = `${rowHeight}px`;
        if (element.style.minHeight !== minimum) element.style.minHeight = minimum;
      }
      if (activeRef.current && element.clientWidth > 0) addon.fit();
    };
    const resize = new ResizeObserver(fitTerminal);
    resize.observe(element);
    if (screen) resize.observe(screen);
    addon.fit();
    terminal.focus();
    return () => {
      lanes.forEach(name => element.removeEventListener(name, keyboardLane, true));
      element.removeEventListener("paste", literalLane, true);
      pointerEvents.forEach(name => document.removeEventListener(name, pointerLane, true));
      resize.disconnect(); output.dispose(); size.dispose(); osc.dispose(); links.dispose(); addon.dispose();
      terminal.attachCustomKeyEventHandler(() => true);
      fit.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    try {applyTerminalTheme(session.terminal, preferences, fontFamilyFor(preferences, fonts));} catch (error) {reportError(String(error));}
    if (active) requestAnimationFrame(() => fit.current?.fit());
  }, [preferences, fonts, session, active]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => { fit.current?.fit(); if (composing) composerInput.current?.focus(); else session.terminal.focus(); });
  }, [active, session, composing]);

  function sendNamed(key: string, physical?: KeyboardEvent) {
    if (!activeRef.current || !session.connected || !mounted.current || !access.current()) return;
    const state = modifierState.current;
    const prefix = `${state.ctrl || physical?.ctrlKey ? "Ctrl+" : ""}${state.meta || physical?.altKey ? "Alt+" : ""}${(state.shift && key.length > 1) || physical?.shiftKey ? "Shift+" : ""}`;
    try {void api.write(session.id, key.length === 1 ? modifiedTerminalText(key, state.ctrl || !!physical?.ctrlKey, state.meta || !!physical?.altKey) : parseChord(`${prefix}${key}`)).catch(error => reportError(String(error)));}
    catch (error) {reportError(error instanceof LocalUiError ? error : String(error)); return;}
    consumeModifiers();
    if (key === "Tab") {modifierState.current.shift = false; setShift(false);}
    session.terminal.focus();
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
      pasteLiteral(text); session.terminal.focus();
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
      void api.writeSequence(session.id, parseChordSteps(keys)).catch(error => {if (current()) reportError(errorMessage(error));});
      return true;
    } catch (error) {if (current()) reportError(error instanceof LocalUiError?error:errorMessage(error)); return false;}
  }
  function runGesture(action: GestureAction, slot?: GestureSlot) {
    const zellijActions = {nextZellijTab:'nextTab',previousZellijTab:'previousTab',nextZellijPane:'nextPane',previousZellijPane:'previousPane'} as const;
    if (Object.hasOwn(zellijActions, action)) {
      if (!mounted.current || !access.current() || !activeRef.current || !session.connected || zellijBusy.current || imeComposing.current || session.terminal.hasSelection()) return;
      if (session.local || session.attached?.kind !== 'zellij') {reportError(new LocalUiError('terminalZellijRequired')); return;}
      zellijBusy.current = true;
      void api.zellijNavigate(session.id, session.attached.name, zellijActions[action as keyof typeof zellijActions])
        .catch(error => {if (mounted.current && access.current() && activeRef.current && session.connected) reportError(errorMessage(error));})
        .finally(() => {zellijBusy.current = false;});
      return;
    }
    if (action === "find") {setSearching(true); requestAnimationFrame(() => searchInput.current?.focus());}
    else if (action === "compose") setComposing(true);
    else if (action === "keyboard") session.terminal.focus();
    else if (action === "hideKeyboard") session.terminal.blur();
    else if (action === "paste") void paste();
    else if (action === "copy") {const text = session.terminal.getSelection(); if (text) void copy(text);}
    else if (action === "nextSession" || action === "previousSession") window.dispatchEvent(new CustomEvent("lazysh-terminal-action", {detail: {sessionId: session.id, action}}));
    else if (action === "custom") {
      sendChord(slot ? preferences.gestureChords[slot] : undefined);
    }
    else {
      const keys = ({left: "\x1b[D", right: "\x1b[C", pageUp: "\x1b[5~", pageDown: "\x1b[6~", escape: "\x1b", tab: "\t", backspace: "\x7f", interrupt: "\x03", none: ""} as Partial<Record<GestureAction,string>>)[action];
      if (keys && session.connected) void api.write(session.id, keys).catch(error => reportError(String(error)));
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
      if (activeRef.current && !imeComposing.current && !session.terminal.hasSelection()) runGesture(preferences.bodyGestures[slot], slot);
    };
    if (count >= 3 || (count === 2 && preferences.bodyGestures.tripleTap === "none") || (count === 1 && preferences.bodyGestures.doubleTap === "none" && preferences.bodyGestures.tripleTap === "none")) perform();
    else taps.current = {count, x, y, when: Date.now(), timer: setTimeout(perform, 350)};
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!customTouch || event.pointerType !== "touch" || imeComposing.current || session.terminal.hasSelection()) return;
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
    if (imeComposing.current || session.terminal.hasSelection()) {gesture.current = null; return;}
    gesture.current.moved.add(event.pointerId);
    // Wait for both touches so a parallel swipe cannot look like a one-sided pinch.
    if (gesture.current.moved.size < 2) return;
    gesture.current.moved.clear();
    const [a, b] = [...pointers.current.values()];
    const scale = Math.hypot(a.x - b.x, a.y - b.y) / gesture.current.distance;
    if (preferences.pinchZoom && Math.abs(scale - 1) >= .08) {
      gesture.current.zoomed = true;
      if (event.cancelable) event.preventDefault();
      const fontSize = Math.max(10, Math.min(32, Math.round(gesture.current.fontSize * scale)));
      if (fontSize !== preferences.fontSize) {
        try {savePreferences({...preferences, fontSize});} catch {reportError(new LocalUiError('terminalFontSaveFailed'));}
      }
    }
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = gesture.current;
    const single = press.current;
    if (single?.id === event.pointerId && pointers.current.size === 1 && !imeComposing.current && !session.terminal.hasSelection()) {
      const dx = event.clientX - single.x, dy = event.clientY - single.y;
      if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        const slot = dx < 0 ? "swipeLeft" : "swipeRight";
        runGesture(preferences.bodyGestures[slot], slot);
      } else if (!single.moved && Math.hypot(dx, dy) <= 10 && Date.now() - single.when <= 500) tap(event.clientX, event.clientY);
      else cancelTaps();
    }
    if (start && pointers.current.size === 2 && !start.zoomed && !imeComposing.current && !session.terminal.hasSelection()) {
      pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
      const [a, b] = [...pointers.current.values()];
      const dx = (a.x + b.x) / 2 - start.x, dy = (a.y + b.y) / 2 - start.y;
      const scale = Math.hypot(a.x - b.x, a.y - b.y) / start.distance;
      if (preferences.pinchZoom && Math.abs(scale - 1) >= .08) {
        try {savePreferences({...preferences, fontSize: Math.max(10, Math.min(32, Math.round(start.fontSize * scale)))});} catch {reportError(new LocalUiError('terminalFontSaveFailed'));}
      } else if (Math.max(Math.abs(dx), Math.abs(dy)) >= 60) {
        const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        const slot = {left: "twoLeft", right: "twoRight", up: "twoUp", down: "twoDown"}[direction] as GestureSlot;
        runGesture(preferences.gestures[direction], slot);
      }
    }
    pointers.current.delete(event.pointerId);
    press.current = null;
    gesture.current = null;
  }
  return <div className="terminal-pane" style={{display: active ? "flex" : "none"}}>
    {(fonts.selection.primary || fonts.selection.cjk) && fonts.warnings.map(warning => <div className="session-notice" role="note" key={fontWarningKey(warning)}>{fontWarningText(warning)}</div>)}
    {!session.connected && <div className="session-notice" role="status">{t("terminalEnded",{details:session.message ? ` · ${session.message}` : ""})}</div>}
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
      <button>{t('terminalNext')}</button><button type="button" onClick={() => search(-1)}>{t('terminalPrevious')}</button><button type="button" onClick={() => {setSearching(false); session.terminal.focus();}}>{t('terminalCloseSearch')}</button>
      <span role="status">{typeof searchStatus === "number" ? t("terminalMatch",{line:formatNumber(searchStatus)}) : searchStatus === "none" ? t("terminalNoMatch") : ""}</span>
    </form>}
    <div ref={container} className="terminal-canvas" style={{touchAction: preferences.screenReader ? "auto" : "none"}} aria-label={t("terminalCanvas",{name:session.name})} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => {pointers.current.clear(); gesture.current = null; press.current = null; cancelTaps();}} onCompositionStartCapture={() => {imeComposing.current = true; pointers.current.clear(); gesture.current = null; press.current = null; cancelTaps();}} onCompositionEndCapture={() => {imeComposing.current = false;}} />
    {composing && <div className="terminal-compose"><label>{t('terminalComposeText')}<textarea ref={composerInput} maxLength={65536} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <button disabled={!session.connected || !draft} onClick={() => {pasteLiteral(draft); setDraft(""); session.terminal.focus();}}>{t('terminalPasteDraft')}</button><button onClick={() => setComposing(false)}>{t('terminalCloseComposer')}</button>
    </div>}
    <div className="terminal-toolbar-toggle">
      <button type="button" className="subtle-button" aria-pressed={composing} onClick={() => setComposing(!composing)}><SquarePen size={16} aria-hidden="true" />{t('terminalCompose')}</button>
      <button type="button" className="subtle-button" onClick={() => setToolbarOverride(!toolbarVisible)} aria-expanded={toolbarVisible}>{toolbarVisible ? <KeyboardOff size={16} aria-hidden="true" /> : <Keyboard size={16} aria-hidden="true" />}{toolbarVisible ? t("terminalHideKeys") : t("terminalShowKeys")}</button>
    </div>
    {ctrlLocked && <div className="sr-only" role="status">{t('terminalControlLocked')}</div>}
    {toolbarVisible && dpadOpen && preferences.toolbar.includes("dpad") && <div className="terminal-dpad" role="group" aria-label={t('terminalDpadGroup')}>
      {preferences.dpadCorners.left === "none" ? <span /> : <button disabled={!session.connected} aria-label={t('terminalDpadLeftCorner')} title={preferences.gestureChords.cornerLeft ?? t(gestureLabelKeys[preferences.dpadCorners.left])} onClick={() => runGesture(preferences.dpadCorners.left, "cornerLeft")}>{preferences.dpadCorners.left === "interrupt" ? "^C" : preferences.dpadCorners.left === "backspace" ? "⌫" : "1"}</button>}
      <button disabled={!session.connected} aria-label={t('terminalDpadUp')} onClick={() => sendKey("\x1b[A")}>↑</button>
      {preferences.dpadCorners.right === "none" ? <span /> : <button disabled={!session.connected} aria-label={t('terminalDpadRightCorner')} title={preferences.gestureChords.cornerRight ?? t(gestureLabelKeys[preferences.dpadCorners.right])} onClick={() => runGesture(preferences.dpadCorners.right, "cornerRight")}>{preferences.dpadCorners.right === "backspace" ? "⌫" : preferences.dpadCorners.right === "interrupt" ? "^C" : "2"}</button>}
      <button disabled={!session.connected} aria-label={t('terminalDpadLeft')} onClick={() => sendKey("\x1b[D")}>←</button><button disabled={!session.connected} aria-label={t('terminalDpadDown')} onClick={() => sendKey("\x1b[B")}>↓</button><button disabled={!session.connected} aria-label={t('terminalDpadRight')} onClick={() => sendKey("\x1b[C")}>→</button>
    </div>}
    {toolbarVisible && <div className="terminal-keys" aria-label={t('terminalKeys')}>
      {preferences.toolbar.map(key => {
        const modifier = key === "ctrl" || key === "meta" || key === "altgr" || key === "shift";
        const locked = key === "ctrl" ? ctrlLocked : key === "meta" ? metaLocked : key === "altgr" ? ctrlLocked && metaLocked : false;
        const pressed = key === "ctrl" ? ctrl : key === "meta" ? meta : key === "shift" ? shift : key === "altgr" ? ctrl && meta : key === "dpad" ? dpadOpen : undefined;
        const action = () => {
          if (key === "ctrl" || key === "meta") cycleModifier(key);
          else if (key === "altgr") {const both = modifierState.current.ctrl && modifierState.current.meta; if (both || !modifierState.current.ctrl) cycleModifier("ctrl"); if (both || !modifierState.current.meta) cycleModifier("meta");}
          else if (key === "shift") {modifierState.current.shift = !shift; setShift(!shift);}
          else if (key === "paste") {if (clipboardPlatform.phase === "ready") void paste(); else if (active && mounted.current && access.current()) void clipboardPlatform.retry();}
          else if (key === "attach") {if (activeRef.current && session.connected && access.current()) onOpenAttachments?.();}
          else if (key === "keyboard") {if (document.activeElement === session.terminal.textarea) session.terminal.blur(); else session.terminal.focus();}
          else if (key === "dpad") setDpadOpen(!dpadOpen);
          else sendKey(sequences[key] ?? key);
        };
        const repeatable = !modifier && key !== "paste" && key !== "attach" && key !== "keyboard" && key !== "dpad";
        return <button key={key} disabled={(!session.connected && key !== "dpad") || (modifier && !modifierInput) || (key === "attach" && (session.local || !onOpenAttachments)) || (key === "paste" && (pasteBusy || clipboardPlatform.phase === "loading"))}
          aria-busy={key === "paste" ? pasteBusy : undefined} aria-pressed={pressed}
          aria-label={labels[key] ? t(arrowLabelKeys[key as keyof typeof arrowLabelKeys]) : undefined}
          title={modifier && !modifierInput ? t("terminalModifiersUnavailable") : undefined}
          onPointerDown={event => {if (key !== "attach") event.preventDefault(); if (repeatable) {stopRepeat(); repeated.current = false; event.currentTarget.setPointerCapture?.(event.pointerId); repeat.current.delay = setTimeout(() => {repeated.current = true; action(); repeat.current.timer = setInterval(action, 80);}, 400);}}}
          onPointerUp={stopRepeat} onPointerCancel={stopRepeat} onLostPointerCapture={stopRepeat} onBlur={stopRepeat}
          onClick={event => {if (!repeatable || !repeated.current || event.detail === 0) action();}}>
          {key === "attach" ? <><Paperclip size={16} aria-hidden="true" />{t("terminalAttach")}</> : labels[key] ?? (key === "paste" ? t(clipboardPlatform.phase === "ready" ? "terminalPaste" : clipboardPlatform.phase === "loading" ? "clipboardChecking" : "clipboardRetry") : key === "dpad" ? t("terminalDpad") : key === "keyboard" ? <Keyboard size={16} aria-label={t("terminalKeyboardToggle")} /> : toolbarKeyLabel(key))}{locked ? ` · ${t("terminalLock")}` : ""}
        </button>;
      })}
      {preferences.snippets.map((snippet, index) => <button key={`snippet-${index}`} disabled={!session.connected} onClick={() => {setDraft(snippet.text); setComposing(true);}}>{snippet.label}</button>)}
      {preferences.chords.map((chord, index) => <button key={`chord-${index}`} title={chord.keys} disabled={!session.connected} onClick={() => {if (sendChord(chord.keys)) session.terminal.focus();}}>{chord.label}</button>)}
      <button onClick={() => {setSearching(!searching); requestAnimationFrame(() => searchInput.current?.focus());}}>{t('terminalFind')}</button>
      <button onClick={() => {const text = session.terminal.getSelection(); if (text) void copy(text); else reportError(new LocalUiError('terminalSelectFirst'));}}>{t('terminalCopy')}</button>
    </div>}
  </div>;
}
