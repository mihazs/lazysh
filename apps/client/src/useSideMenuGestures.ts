import {type RefObject, useLayoutEffect} from 'react';
import {useEdgeGestures, useSwipeToClose} from './edgeGestures';

/** The page tracks the finger through `--side-menu-progress` (0 closed, 1 open) while `data-dragging` is set. */
function follow(menu: RefObject<HTMLElement | null>, progress: number) {
  const node = menu.current;
  if (!node) return;
  node.removeAttribute('data-settling');
  node.setAttribute('data-dragging', '');
  node.style.setProperty('--side-menu-progress', String(progress));
}
function clear(node: HTMLElement) {
  for (const name of ['data-settling', 'data-dragging']) node.removeAttribute(name);
  node.style.removeProperty('--side-menu-progress');
}
/** Slides the page to its end state. Open holds its position until the page closes, so the stylesheet's open animation does not replay under the finger; closed hands back once it has slid. */
function settle(menu: RefObject<HTMLElement | null>, progress: 0 | 1) {
  const node = menu.current;
  if (!node) return;
  node.setAttribute('data-settling', '');
  node.style.setProperty('--side-menu-progress', String(progress));
  if (progress === 0) window.setTimeout(() => { if (node.hasAttribute('data-settling')) clear(node); }, 220);
}

/** A swipe from the left edge drags the side menu page open; the opposite swipe on it drags it shut. */
export function useSideMenuGestures({shell, menu, enabled, open, onOpen, onClose}: {
  shell: RefObject<HTMLElement | null>;
  menu: RefObject<HTMLElement | null>;
  /** The gesture may act at all: a phone session, the gesture switched on, no dialog over it. */
  enabled: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  // However the page closed (button, Back, swipe), it hands its position back to the stylesheet.
  useLayoutEffect(() => { if (!open && menu.current) clear(menu.current); }, [open, menu]);
  useEdgeGestures({
    enabled: enabled && !open, edges: ['left'], target: shell,
    handlers: {
      onProgress: (_edge, progress) => follow(menu, progress),
      onCommit: () => { settle(menu, 1); onOpen(); },
      onCancel: () => settle(menu, 0),
    },
  });
  useSwipeToClose({
    enabled: enabled && open, direction: 'left', target: menu,
    onProgress: progress => follow(menu, 1 - progress),
    onCommit: () => { settle(menu, 0); onClose(); },
    onCancel: () => settle(menu, 1),
  });
}
