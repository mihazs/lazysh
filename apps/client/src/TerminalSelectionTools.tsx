import {useEffect, useRef, type PointerEvent as ReactPointerEvent} from 'react';
import {t} from './i18n/core';
import type {TerminalAdapter} from './terminalAdapter';
import {edgeOverflow, edgeScrollRate, edgeScrollStep, rangeBetween, type TerminalCell} from './terminalTouchSelection';

const HANDLE = 28;
type Handle = 'start' | 'end';
type Drag = {pointer: number; fixed: TerminalCell; dx: number; dy: number; x: number; y: number; frame: number; last: number; carry: number};

/**
 * Selection handles and actions over a live terminal. Handles move a selection
 * endpoint across rows; held past the top or bottom edge they scroll local
 * history, so a selection can span more than one screen. Positions follow
 * scrolling and output only while this is mounted.
 */
export default function TerminalSelectionTools({adapter, handles, onCopy, onDone}: {
  adapter: TerminalAdapter; handles: boolean; onCopy: (text: string) => void; onDone: () => void;
}) {
  const start = useRef<HTMLDivElement>(null), end = useRef<HTMLDivElement>(null), bar = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const range = adapter.getSelection()?.range, rect = adapter.screenBounds(), {columns, rows} = adapter.size();
      if (!range || !rect || !columns || !rows) return;
      // Handles sit on cell edges: the end handle after the last selected cell.
      const position = {start: range.start, end: {x: range.end.x + 1, y: range.end.y}};
      const width = rect.width / columns, height = rect.height / rows, top = adapter.viewport().top;
      const row = (y: number) => y - top, visible = (y: number) => row(y) >= 0 && row(y) < rows;
      const put = (node: HTMLElement | null, x: number, y: number) => {
        if (!node) return;
        node.style.display = visible(y) ? '' : 'none';
        if (visible(y)) node.style.transform = `translate(${rect.left + x * width - HANDLE / 2}px, ${rect.top + (row(y) + 1) * height}px)`;
      };
      put(start.current, position.start.x, position.start.y);
      put(end.current, position.end.x, position.end.y);
      const tools = bar.current;
      if (!tools) return;
      const size = tools.getBoundingClientRect();
      const above = visible(position.start.y) && rect.top + row(position.start.y) * height - size.height - 6 >= rect.top;
      const y = above ? rect.top + row(position.start.y) * height - size.height - 6
        : visible(position.end.y) && rect.top + (row(position.end.y) + 1) * height + HANDLE + size.height <= rect.top + rect.height ? rect.top + (row(position.end.y) + 1) * height + HANDLE
        : rect.top + 6;
      const x = Math.max(rect.left, Math.min(rect.left + rect.width - size.width, rect.left + (visible(position.start.y) ? position.start.x * width : 0)));
      tools.style.transform = `translate(${x}px, ${y}px)`;
    };
    const schedule = () => {if (!frame) frame = requestAnimationFrame(place);};
    const listener = adapter.subscribe(event => {
      if (event.type === 'selection') {if (event.range) schedule(); else done.current();}
      else schedule();
    }, ['selection', 'viewport', 'geometry']);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      if (drag.current) cancelAnimationFrame(drag.current.frame);
      drag.current = null;
      listener.dispose();
      window.removeEventListener('resize', schedule);
    };
  }, [adapter]);

  /** Selects from the fixed endpoint through the cell under the dragged point, clamped to the screen. */
  function extend(state: Drag) {
    const cell = adapter.cellAt(state.x - state.dx, state.y - state.dy);
    if (cell) adapter.select(rangeBetween(state.fixed, cell));
  }
  function edge(now: number) {
    const state = drag.current, rect = adapter.screenBounds();
    if (!state || !rect) return;
    const rate = edgeScrollRate(edgeOverflow(state.y - state.dy, rect.top, rect.top + rect.height), rect.height / adapter.size().rows);
    if (!rate) {state.frame = 0; return;}
    const step = edgeScrollStep(rate, state.last ? now - state.last : 16, state.carry);
    state.carry = step.carry; state.last = now;
    if (step.rows) adapter.scroll({kind: 'lines', delta: step.rows});
    extend(state);
    state.frame = requestAnimationFrame(edge);
  }
  function grab(which: Handle) {
    return {
      onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
        const range = adapter.getSelection()?.range, rect = adapter.screenBounds(), {columns, rows} = adapter.size();
        if (!range || !rect || !columns || !rows || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        try {event.currentTarget.setPointerCapture(event.pointerId);} catch {/* Without capture, moves still arrive while over the handle. */}
        const width = rect.width / columns, height = rect.height / rows, handle = event.currentTarget.getBoundingClientRect();
        // The dragged point is the selected cell's centre, which sits above the handle.
        const cellX = handle.left + HANDLE / 2 + (which === 'start' ? width / 2 : -width / 2), cellY = handle.top - height / 2;
        const fixed = which === 'end' ? range.start : range.end;
        drag.current = {pointer: event.pointerId, fixed, dx: event.clientX - cellX, dy: event.clientY - cellY, x: event.clientX, y: event.clientY, frame: 0, last: 0, carry: 0};
      },
      onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
        const state = drag.current;
        if (!state || state.pointer !== event.pointerId) return;
        event.preventDefault();
        state.x = event.clientX; state.y = event.clientY;
        extend(state);
        if (!state.frame) {state.last = 0; state.frame = requestAnimationFrame(edge);}
      },
      onPointerUp: release, onPointerCancel: release, onLostPointerCapture: release,
    };
  }
  function release() {
    if (drag.current) cancelAnimationFrame(drag.current.frame);
    drag.current = null;
  }
  function copyAndClose(text: string) {
    if (text) onCopy(text);
    adapter.clearSelection();
  }
  const handle = (which: Handle) => <div ref={which === 'start' ? start : end} role="button" tabIndex={-1}
    aria-label={t(which === 'start' ? 'terminalSelectionStart' : 'terminalSelectionEnd')} data-selection-handle={which} data-edge-gestures-ignore="" {...grab(which)}
    style={{position: 'fixed', left: 0, top: 0, zIndex: 1000, width: HANDLE, height: HANDLE, touchAction: 'none', cursor: 'grab',
      borderRadius: which === 'start' ? '50% 0 50% 50%' : '0 50% 50% 50%', background: 'var(--theme-accent, #7aa2f7)', opacity: .9}} />;
  return <>
    {handles && handle('start')}
    {handles && handle('end')}
    <div ref={bar} className="terminal-selection-tools" role="toolbar" data-edge-gestures-ignore="" aria-label={t('terminalSelectionTools')} onPointerDown={event => event.preventDefault()}
      style={{position: 'fixed', left: 0, top: 0, zIndex: 1001, display: 'flex', gap: 4, padding: 4, borderRadius: 8}}>
      <button type="button" onClick={() => copyAndClose(adapter.selectedText())}>{t('terminalCopy')}</button>
      <button type="button" onClick={() => adapter.selectAll()}>{t('terminalSelectAll')}</button>
      <button type="button" onClick={() => {
        const {columns, rows} = adapter.size(), top = adapter.viewport().top;
        adapter.select({start: {x: 0, y: top}, end: {x: columns - 1, y: top + rows - 1}});
        copyAndClose(adapter.selectedText());
      }}>{t('terminalCopyScreen')}</button>
    </div>
  </>;
}
