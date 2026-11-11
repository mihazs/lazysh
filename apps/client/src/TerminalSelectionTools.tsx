import {useEffect, useRef, type PointerEvent as ReactPointerEvent} from 'react';
import type {Terminal} from '@xterm/xterm';
import {t} from './i18n/core';
import {edgeOverflow, edgeScrollRate, edgeScrollStep, inclusiveEnd, rangeBetween, selectTerminalRange, terminalCellAt, type TerminalCell} from './terminalTouchSelection';

const HANDLE = 28;
type Handle = 'start' | 'end';
type Drag = {pointer: number; fixed: TerminalCell; dx: number; dy: number; x: number; y: number; frame: number; last: number; carry: number};

/**
 * Selection handles and actions over a live terminal. Handles move a selection
 * endpoint across rows; held past the top or bottom edge they scroll local
 * history, so a selection can span more than one screen. Positions follow
 * scrolling and output only while this is mounted.
 */
export default function TerminalSelectionTools({terminal, handles, onCopy, onDone}: {
  terminal: Terminal; handles: boolean; onCopy: (text: string) => void; onDone: () => void;
}) {
  const start = useRef<HTMLDivElement>(null), end = useRef<HTMLDivElement>(null), bar = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const screen = () => terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();

  useEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const position = terminal.getSelectionPosition(), rect = screen();
      if (!position || !rect || !terminal.cols || !terminal.rows) return;
      const width = rect.width / terminal.cols, height = rect.height / terminal.rows, top = terminal.buffer.active.viewportY;
      const row = (y: number) => y - top, visible = (y: number) => row(y) >= 0 && row(y) < terminal.rows;
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
        : visible(position.end.y) && rect.top + (row(position.end.y) + 1) * height + HANDLE + size.height <= rect.bottom ? rect.top + (row(position.end.y) + 1) * height + HANDLE
        : rect.top + 6;
      const x = Math.max(rect.left, Math.min(rect.right - size.width, rect.left + (visible(position.start.y) ? position.start.x * width : 0)));
      tools.style.transform = `translate(${x}px, ${y}px)`;
    };
    const schedule = () => {if (!frame) frame = requestAnimationFrame(place);};
    const changed = () => {if (terminal.hasSelection()) schedule(); else done.current();};
    const listeners = [terminal.onSelectionChange(changed), terminal.onScroll(schedule), terminal.onRender(schedule), terminal.onResize(schedule)];
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      if (drag.current) cancelAnimationFrame(drag.current.frame);
      drag.current = null;
      listeners.forEach(listener => listener.dispose());
      window.removeEventListener('resize', schedule);
    };
  }, [terminal]);

  /** Selects from the fixed endpoint through the cell under the dragged point, clamped to the screen. */
  function extend(state: Drag) {
    const cell = terminalCellAt(terminal, state.x - state.dx, state.y - state.dy);
    if (cell) selectTerminalRange(terminal, rangeBetween(state.fixed, cell));
  }
  function edge(now: number) {
    const state = drag.current, rect = screen();
    if (!state || !rect) return;
    const rate = edgeScrollRate(edgeOverflow(state.y - state.dy, rect.top, rect.bottom), rect.height / terminal.rows);
    if (!rate) {state.frame = 0; return;}
    const step = edgeScrollStep(rate, state.last ? now - state.last : 16, state.carry);
    state.carry = step.carry; state.last = now;
    if (step.rows) terminal.scrollLines(step.rows);
    extend(state);
    state.frame = requestAnimationFrame(edge);
  }
  function grab(which: Handle) {
    return {
      onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
        const position = terminal.getSelectionPosition(), rect = screen();
        if (!position || !rect || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        try {event.currentTarget.setPointerCapture(event.pointerId);} catch {/* Without capture, moves still arrive while over the handle. */}
        const width = rect.width / terminal.cols, height = rect.height / terminal.rows, handle = event.currentTarget.getBoundingClientRect();
        // The dragged point is the selected cell's centre, which sits above the handle.
        const cellX = handle.left + HANDLE / 2 + (which === 'start' ? width / 2 : -width / 2), cellY = handle.top - height / 2;
        const fixed = which === 'end' ? position.start : inclusiveEnd(position.end, terminal.cols);
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
    terminal.clearSelection();
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
      <button type="button" onClick={() => copyAndClose(terminal.getSelection())}>{t('terminalCopy')}</button>
      <button type="button" onClick={() => terminal.selectAll()}>{t('terminalSelectAll')}</button>
      <button type="button" onClick={() => {terminal.select(0, terminal.buffer.active.viewportY, terminal.rows * terminal.cols); copyAndClose(terminal.getSelection());}}>{t('terminalCopyScreen')}</button>
    </div>
  </>;
}
