import {useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {Keyboard, Paperclip, Plus, Trash2, X} from "lucide-react";
import {t} from "./i18n/core";
import {discreteGestureActions, maxToolbarRows, toolbarFromRows, toolbarKeyHasAlternate, toolbarKeyLabel, toolbarKeys, toolbarRows, type GestureAction, type Preferences, type ToolbarKey} from "./preferences";
import GestureBindingField from "./GestureBindingField";
import {findToolbarKey, placeToolbarKey, removeToolbarKey, resizeToolbarRows, toolbarStepSlot, type ToolbarRows, type ToolbarSlot, type ToolbarStep} from "./toolbarLayout";
import "./ToolbarKeysEditor.css";

type Source = "row" | "palette";
type DropTarget = {kind: "slot"; slot: ToolbarSlot} | {kind: "remove"};
type Drag = {key: ToolbarKey; from: Source; x: number; y: number; touch: boolean; target?: DropTarget};
type Press = {key: ToolbarKey; from: Source; pointerId: number; touch: boolean; x: number; y: number; timer?: number; active: boolean; source: HTMLElement};

/** Touch drags start after a hold so a swipe over the keys still scrolls the settings page. */
const holdMs = 280;
const mouseSlop = 5;
const touchSlop = 10;
const scrollEdge = 56;
const clickGuardMs = 450;
const arrowSteps: Record<string, ToolbarStep> = {ArrowLeft: "earlier", ArrowRight: "later", ArrowUp: "up", ArrowDown: "down"};
const glyphs: Partial<Record<ToolbarKey, string>> = {left: "←", up: "↑", down: "↓", right: "→"};
type Focus = {kind: "chip" | "palette"; key: ToolbarKey} | {kind: "actions"};
const chipFocus = (key: ToolbarKey): Focus => ({kind: "chip", key});
const paletteFocus = (key: ToolbarKey): Focus => ({kind: "palette", key});
function focusTarget(root: HTMLElement, focus: Focus): HTMLElement | undefined {
  if (focus.kind === "actions") return root.querySelector<HTMLElement>("[data-key-actions] button") ?? undefined;
  const attribute = focus.kind === "chip" ? "focusChip" : "focusPalette";
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-focus-${focus.kind}]`)).find(element => element.dataset[attribute] === focus.key);
}
/** Touch events keep targeting the node where the hold began, even after a drop preview re-parents it. */
const holdScroll = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); };

/** The face each key shows in the terminal toolbar, for the preview. */
function terminalFace(key: ToolbarKey): ReactNode {
  if (key === "attach") return <><Paperclip size={14} aria-hidden="true" />{t("terminalAttach")}</>;
  if (key === "keyboard") return <Keyboard size={14} aria-hidden="true" />;
  return glyphs[key] ?? (key === "paste" ? t("terminalPaste") : key === "dpad" ? t("terminalDpad") : toolbarKeyLabel(key));
}

function dropTarget(x: number, y: number, drag: Pick<Drag, "key" | "from">): DropTarget | undefined {
  const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-toolbar-drop]");
  if (!zone) return;
  if (zone.dataset.toolbarDrop === "remove") return drag.from === "row" ? {kind: "remove"} : undefined;
  const chips = Array.from(zone.querySelectorAll<HTMLElement>("[data-chip-key]")).filter(chip => chip.dataset.chipKey !== drag.key);
  const index = chips.findIndex(chip => {
    const box = chip.getBoundingClientRect();
    return y < box.top || (y <= box.bottom && x < box.left + box.width / 2);
  });
  return {kind: "slot", slot: {row: Number(zone.dataset.toolbarDrop), index: index < 0 ? chips.length : index}};
}

function scroller(element: HTMLElement | null): HTMLElement {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement as HTMLElement ?? document.documentElement;
}

export default function ToolbarKeysEditor({preferences, update}: {preferences: Preferences; update: (patch: Partial<Preferences>) => boolean}) {
  const rows = toolbarRows(preferences.toolbar);
  const [selected, setSelected] = useState<ToolbarKey>();
  const [drag, setDrag] = useState<Drag>();
  const [announcement, setAnnouncement] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const press = useRef<Press | undefined>(undefined);
  const dragRef = useRef<Drag | undefined>(undefined);
  const clickGuard = useRef(0);
  const focusAfter = useRef<Focus | undefined>(undefined);
  const id = useId();
  const shortcutsId = `${id}-shortcuts`, panelId = `${id}-actions`;

  function show(next: Drag | undefined) { dragRef.current = next; setDrag(next); }
  function commit(next: ToolbarRows, message: string, focus?: Focus) {
    if (!update({toolbar: toolbarFromRows(next)})) return;
    focusAfter.current = focus;
    setAnnouncement(message);
  }
  function place(key: ToolbarKey, slot: ToolbarSlot, from: Source, focus?: Focus) {
    const next = placeToolbarKey(rows, key, slot), at = findToolbarKey(next, key)!;
    commit(next, t(from === "palette" ? "preferencesToolbarKeyAdded" : "preferencesToolbarKeyMoved", {key: toolbarKeyLabel(key), row: String(at.row + 1), position: String(at.index + 1)}), focus);
  }
  function remove(key: ToolbarKey) {
    const at = findToolbarKey(rows, key);
    if (!at) return;
    const neighbour = rows[at.row][at.index + 1] ?? rows[at.row][at.index - 1];
    if (selected === key) setSelected(undefined);
    commit(removeToolbarKey(rows, key), t("preferencesToolbarKeyRemovedValue1", {value1: toolbarKeyLabel(key)}), neighbour ? chipFocus(neighbour) : paletteFocus(key));
  }
  function step(key: ToolbarKey, direction: ToolbarStep, focus?: Focus) {
    const slot = toolbarStepSlot(rows, key, direction);
    if (slot) place(key, slot, "row", focus);
    else setAnnouncement(t("preferencesToolbarKeyUnchangedValue1", {value1: toolbarKeyLabel(key)}));
  }
  function add(key: ToolbarKey) {
    const available = toolbarKeys.filter(item => !findToolbarKey(rows, item));
    const index = available.indexOf(key), neighbour = available[index + 1] ?? available[index - 1];
    const last = rows.length - 1;
    place(key, {row: last, index: rows[last].length}, "palette", neighbour ? paletteFocus(neighbour) : chipFocus(key));
  }
  function drop(current: Drag) {
    const {key, from, target} = current;
    if (target?.kind === "slot") place(key, target.slot, from, from === "row" ? chipFocus(key) : undefined);
    else if (target?.kind === "remove") remove(key);
    else setAnnouncement(t("preferencesToolbarDragCancelled"));
  }
  function release() {
    const current = press.current;
    if (current?.timer !== undefined) window.clearTimeout(current.timer);
    current?.source.removeEventListener("touchmove", holdScroll);
    press.current = undefined;
  }
  function activate(current: Press) {
    if (current.timer !== undefined) window.clearTimeout(current.timer);
    current.timer = undefined;
    current.active = true;
    if (current.touch) current.source.addEventListener("touchmove", holdScroll, {passive: false});
    setSelected(undefined);
    show({key: current.key, from: current.from, x: current.x, y: current.y, touch: current.touch, target: dropTarget(current.x, current.y, current)});
  }
  function pointerDown(event: ReactPointerEvent<HTMLElement>, key: ToolbarKey, from: Source) {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    release();
    const current: Press = {key, from, pointerId: event.pointerId, touch: event.pointerType !== "mouse", x: event.clientX, y: event.clientY, active: false, source: event.currentTarget};
    if (current.touch) current.timer = window.setTimeout(() => activate(current), holdMs);
    press.current = current;
  }
  const guarded = () => performance.now() - clickGuard.current < clickGuardMs;

  /** Escape cancels a drag or closes the key actions before Settings treats it as Back. */
  function escape() {
    const current = press.current;
    if (current?.active) {
      clickGuard.current = performance.now();
      release();
      show(undefined);
      drop({...current, x: 0, y: 0});
      return true;
    }
    if (!selected || !root.current?.contains(document.activeElement)) return false;
    closeActions();
    return true;
  }
  // Window listeners keep a drag alive outside its source chip; the handlers read refs, not stale state.
  const live = useRef({drop, release, activate, show, escape});
  live.current = {drop, release, activate, show, escape};
  // A layout effect registers before the Settings navigation's own capture listener (children commit first).
  useLayoutEffect(() => {
    const move = (event: PointerEvent) => {
      const current = press.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const distance = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (!current.active) {
        // A touch that travels before the hold completes is a scroll, never a drag.
        if (current.touch) { if (distance > touchSlop) live.current.release(); }
        else if (distance > mouseSlop) { current.x = event.clientX; current.y = event.clientY; live.current.activate(current); }
        return;
      }
      const previous = dragRef.current;
      if (previous) live.current.show({...previous, x: event.clientX, y: event.clientY, target: dropTarget(event.clientX, event.clientY, previous)});
    };
    const up = (event: PointerEvent) => {
      const current = press.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const dragged = dragRef.current;
      live.current.release();
      if (!current.active || !dragged) return;
      clickGuard.current = performance.now();
      live.current.show(undefined);
      live.current.drop(dragged);
    };
    const cancel = (event: PointerEvent) => {
      const current = press.current;
      if (!current || event.pointerId !== current.pointerId) return;
      live.current.release();
      if (current.active) { clickGuard.current = performance.now(); live.current.show(undefined); live.current.drop({...current, x: 0, y: 0}); }
    };
    // Once a held touch becomes a drag, the page must not scroll under it.
    const touchMove = (event: TouchEvent) => { if (press.current?.active && event.cancelable) event.preventDefault(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && live.current.escape()) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", touchMove, {passive: false});
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("keydown", key, true);
      live.current.release();
    };
  }, []);

  // Scroll the settings page while a drag rests near its top or bottom edge.
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    const container = scroller(root.current);
    let frame = requestAnimationFrame(function tick() {
      const current = dragRef.current;
      if (current && current.target?.kind !== "remove") {
        const box = container === document.scrollingElement ? {top: 0, bottom: innerHeight} : container.getBoundingClientRect();
        const delta = current.y < box.top + scrollEdge ? -Math.ceil((box.top + scrollEdge - current.y) / 4) : current.y > box.bottom - scrollEdge ? Math.ceil((current.y - box.bottom + scrollEdge) / 4) : 0;
        if (delta) {
          const before = container.scrollTop;
          container.scrollTop += delta;
          if (container.scrollTop !== before) live.current.show({...current, target: dropTarget(current.x, current.y, current)});
        }
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  useLayoutEffect(() => {
    const focus = focusAfter.current;
    if (!focus || !root.current) return;
    focusAfter.current = undefined;
    focusTarget(root.current, focus)?.focus();
  });

  function chipKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, key: ToolbarKey) {
    const direction = arrowSteps[event.key];
    if (direction && event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); step(key, direction, chipFocus(key)); }
    else if ((event.key === "Delete" || event.key === "Backspace") && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); remove(key); }
  }
  function openActions(key: ToolbarKey) {
    if (guarded()) return;
    if (selected === key) { setSelected(undefined); return; }
    setSelected(key);
    focusAfter.current = {kind: "actions"};
  }
  /** Saves or clears one key's long-press action; a chord applies only to a custom action. */
  function setAlternate(key: ToolbarKey, action: GestureAction, keys?: string) {
    const {[key]: _previous, ...others} = preferences.toolbarAlternates ?? {};
    return update({toolbarAlternates: action === "none" ? others : {...others, [key]: action === "custom" ? {action, ...(keys === undefined ? {} : {keys})} : {action}}});
  }
  function closeActions() {
    const key = selected;
    setSelected(undefined);
    if (key) focusAfter.current = chipFocus(key);
  }

  // The preview shows the pending drop; the editor keeps every chip in place so the layout under the pointer stays still.
  const preview = drag?.target?.kind === "slot" ? placeToolbarKey(rows, drag.key, drag.target.slot) : drag?.target?.kind === "remove" ? removeToolbarKey(rows, drag.key) : rows;
  const slot = drag?.target?.kind === "slot" ? drag.target.slot : undefined;
  const chip = (key: ToolbarKey) => <span key={key} className="toolbar-chip" data-chip-key={key} data-dragging={drag?.key === key || undefined} data-selected={selected === key || undefined}>
    <button type="button" className="toolbar-chip-key" data-focus-chip={key} aria-describedby={shortcutsId} aria-expanded={selected === key} aria-controls={selected === key ? panelId : undefined}
      onPointerDown={event => pointerDown(event, key, "row")} onContextMenu={event => event.preventDefault()}
      onKeyDown={event => chipKeyDown(event, key)} onClick={() => openActions(key)}>{label(key)}</button>
    <button type="button" className="toolbar-chip-remove" aria-label={t("preferencesRemoveValue1", {value1: key})} onClick={() => { if (!guarded()) remove(key); }}><X size={14} aria-hidden="true" /></button>
  </span>;
  /** Chips of one row with the drop placeholder at its slot, counted without the dragged key. */
  const rowItems = (row: readonly ToolbarKey[], index: number): ReactNode[] => {
    const items = row.map(chip);
    if (!drag || slot?.row !== index) return items;
    const position = row.filter(key => key !== drag.key).slice(0, slot.index).at(-1);
    const at = position === undefined ? 0 : row.indexOf(position) + 1;
    items.splice(at, 0, <span key="drop-slot" className="toolbar-drop-slot" aria-hidden="true">{label(drag.key)}</span>);
    return items;
  };
  const available = toolbarKeys.filter(key => !findToolbarKey(rows, key));
  const at = selected && findToolbarKey(rows, selected);
  const label = (key: ToolbarKey) => toolbarKeyLabel(key);

  return <div className="toolbar-editor" ref={root} data-dragging={dragging || undefined}>
    <label>{t("preferencesToolbarRows")}<select value={rows.length} onChange={event => {const count = Number(event.target.value); commit(resizeToolbarRows(rows, count), t("preferencesToolbarRowsChangedValue1", {value1: String(count)}));}}>
      {Array.from({length: maxToolbarRows}, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
    </select></label>
    <p>{t("preferencesToolbarDragHint")}</p>
    <span id={shortcutsId} className="sr-only">{t("preferencesToolbarKeyShortcuts")}</span>
    <figure className="toolbar-preview">
      <figcaption>{t("preferencesToolbarPreview")}</figcaption>
      <div className="toolbar-preview-keys" aria-hidden="true">
        {preview.map((row, index) => <div key={index} className="toolbar-preview-row" data-empty={!row.length && index !== preview.length - 1 || undefined}>
          {row.map(key => <span key={key} data-preview-key={key}>{terminalFace(key)}</span>)}
          {index === preview.length - 1 && <>
            {preferences.snippets.map((snippet, item) => <span key={`snippet-${item}`} className="toolbar-preview-fixed">{snippet.label}</span>)}
            {preferences.chords.map((chord, item) => <span key={`chord-${item}`} className="toolbar-preview-fixed">{chord.label}</span>)}
            <span className="toolbar-preview-fixed">{t("terminalFind")}</span>
            <span className="toolbar-preview-fixed">{t("terminalCopy")}</span>
          </>}
        </div>)}
      </div>
    </figure>
    <div className="toolbar-editor-rows">
      {rows.map((row, index) => <div key={index} className="toolbar-editor-row" role="group" aria-label={t("preferencesToolbarRowValue1", {value1: String(index + 1)})} data-toolbar-drop={index} data-target={slot?.row === index || undefined}>
        {rows.length > 1 && <span className="toolbar-editor-row-label" aria-hidden="true">{index + 1}</span>}
        {rowItems(row, index)}
        {!row.length && slot?.row !== index && <span className="toolbar-editor-empty">{t("preferencesToolbarEmptyRow")}</span>}
      </div>)}
    </div>
    {selected && at && <div id={panelId} data-key-actions="" className="toolbar-key-actions" role="group" aria-label={t("preferencesToolbarKeyActionsValue1", {value1: label(selected)})}>
      <strong aria-hidden="true">{label(selected)}</strong>
      <button type="button" aria-label={t("preferencesMoveValue1Earlier", {value1: selected})} aria-disabled={!toolbarStepSlot(rows, selected, "earlier")} onClick={() => step(selected, "earlier")}>{t("preferencesToolbarEarlier")}</button>
      <button type="button" aria-label={t("preferencesMoveValue1Later", {value1: selected})} aria-disabled={!toolbarStepSlot(rows, selected, "later")} onClick={() => step(selected, "later")}>{t("preferencesToolbarLater")}</button>
      {rows.length > 1 && rows.map((row, index) => index === at.row ? null : <button key={index} type="button" aria-label={t("preferencesToolbarMoveToRow", {key: selected, row: String(index + 1)})} onClick={() => place(selected, {row: index, index: row.length}, "row")}>{t("preferencesToolbarRowValue1", {value1: String(index + 1)})}</button>)}
      {toolbarKeyHasAlternate(selected) && <div className="toolbar-key-alternate">
        <GestureBindingField label={t("preferencesToolbarLongPress", {value1: label(selected)})} action={preferences.toolbarAlternates?.[selected]?.action ?? "none"} keys={preferences.toolbarAlternates?.[selected]?.keys}
          allowed={discreteGestureActions} onAction={action => setAlternate(selected, action, preferences.toolbarAlternates?.[selected]?.keys)} onKeys={keys => setAlternate(selected, "custom", keys)} />
        <p>{t("preferencesToolbarLongPressHint")}</p>
      </div>}
      <button type="button" onClick={closeActions}>{t("preferencesToolbarDone")}</button>
    </div>}
    <section className="toolbar-palette" aria-label={t("preferencesToolbarAvailableKeys")} data-toolbar-drop="remove">
      <h3>{t("preferencesToolbarAvailableKeys")}</h3>
      <div className="toolbar-palette-keys">
        {available.map(key => <button key={key} type="button" className="toolbar-palette-key" data-focus-palette={key} data-dragging={drag?.key === key || undefined}
          onPointerDown={event => pointerDown(event, key, "palette")} onContextMenu={event => event.preventDefault()}
          aria-label={`${t("preferencesAdd")} ${label(key)}`}
          onClick={() => { if (!guarded()) add(key); }}><Plus size={14} aria-hidden="true" /><span className="sr-only">{t("preferencesAdd")}</span>{" "}{label(key)}</button>)}
      </div>
    </section>
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    {drag && createPortal(<>
      {drag.from === "row" && <div className="toolbar-remove-zone" data-toolbar-drop="remove" data-target={drag.target?.kind === "remove" || undefined} aria-hidden="true"><Trash2 size={18} aria-hidden="true" />{t("preferencesToolbarDropToRemove")}</div>}
      <div className="toolbar-drag-ghost" data-touch={drag.touch || undefined} style={{left: drag.x, top: drag.y}} aria-hidden="true">{label(drag.key)}</div>
    </>, document.body)}
  </div>;
}
