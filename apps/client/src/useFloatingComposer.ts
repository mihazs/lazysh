import {useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject} from 'react';
import {clampFloat, defaultFloat, loadFloat, saveFloat, type Band, type ComposerFloat} from './composerFloat';

const step = 16, bigStep = 64;

/**
 * The floating composer's place over the terminal area (its offset parent), kept on this device. The panel
 * never changes the layout: it is pinned by `left` and `bottom`, clamped inside the area on every resize, and
 * lifted by `--terminal-composer-keyboard` where a soft keyboard covers the area without resizing it (WebKit);
 * Android resizes the web view itself, so the area already ends above the keyboard.
 */
export function useFloatingComposer(enabled: boolean, root: RefObject<HTMLElement | null>, cursor?: () => Band | null) {
  // Folded only for as long as this panel is open: reopening the composer always brings the editor back.
  const [collapsed, setCollapsed] = useState(false);
  const place = useRef<ComposerFloat | null>(null);
  const covered = useRef(0);
  const cursorBand = useRef(cursor);
  cursorBand.current = cursor;
  const drag = useRef<{id: number; x: number; y: number; from: ComposerFloat} | null>(null);

  const measure = useCallback(() => {
    const panel = root.current, area = panel?.offsetParent;
    if (!panel || !area) return null;
    const viewport = window.visualViewport;
    covered.current = viewport ? Math.max(0, Math.round(area.getBoundingClientRect().bottom - (viewport.offsetTop + viewport.height))) : 0;
    const top = area.getBoundingClientRect().top;
    const band = cursorBand.current?.();
    return {panel, cursor: band ? {top: band.top - top, bottom: band.bottom - top} : null, size: {width: panel.offsetWidth, height: panel.offsetHeight}, area: {width: area.clientWidth, height: Math.max(0, area.clientHeight - covered.current)}};
  }, [root]);
  const apply = useCallback((next: ComposerFloat) => {
    place.current = next;
    const panel = root.current;
    if (!panel) return;
    panel.style.setProperty('--terminal-composer-left', `${next.left}px`);
    panel.style.setProperty('--terminal-composer-bottom', `${next.bottom + covered.current}px`);
  }, [root]);
  const settle = useCallback(() => {
    const found = measure();
    if (found) apply(clampFloat(place.current ?? loadFloat() ?? defaultFloat(found.area, found.size, found.cursor), found.area, found.size));
  }, [apply, measure]);

  // Placed before the first paint, and again whenever the area, the panel or the keyboard changes its room.
  useLayoutEffect(() => {
    if (!enabled) return;
    settle();
    const panel = root.current, area = panel?.offsetParent, viewport = window.visualViewport;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(settle) : undefined;
    if (panel) observer?.observe(panel);
    if (area) observer?.observe(area);
    viewport?.addEventListener('resize', settle); viewport?.addEventListener('scroll', settle);
    return () => {observer?.disconnect(); viewport?.removeEventListener('resize', settle); viewport?.removeEventListener('scroll', settle);};
  }, [enabled, root, settle, collapsed]);

  // Only a move or a collapse stores anything: until then the default place follows the width of the screen.
  const remember = (next: ComposerFloat) => {apply(next); saveFloat(next);};
  const moveTo = (next: ComposerFloat) => {
    const found = measure();
    remember(found ? clampFloat(next, found.area, found.size) : next);
  };

  const grip = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0 || !place.current) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, from: place.current};
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const held = drag.current, found = measure();
      if (!held || held.id !== event.pointerId || !found) return;
      apply(clampFloat({left: held.from.left + event.clientX - held.x, bottom: held.from.bottom - (event.clientY - held.y)}, found.area, found.size));
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null;
      if (place.current) saveFloat(place.current);
    },
    onPointerCancel() {drag.current = null;},
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      const current = place.current, found = measure();
      if (!current || !found) return;
      const move = event.shiftKey ? bigStep : step;
      const delta: Record<string, [number, number]> = {ArrowLeft: [-move, 0], ArrowRight: [move, 0], ArrowUp: [0, move], ArrowDown: [0, -move]};
      if (event.key === 'Home') remember(defaultFloat(found.area, found.size, found.cursor));
      else if (delta[event.key]) moveTo({left: current.left + delta[event.key][0], bottom: current.bottom + delta[event.key][1]});
      else return;
      event.preventDefault(); event.stopPropagation();
    },
  };
  return {collapsed, setCollapsed, grip};
}
