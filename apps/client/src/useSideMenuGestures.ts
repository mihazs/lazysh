import {type RefObject} from 'react';
import {useEdgeGestures, useSwipeToClose} from './edgeGestures';

/** Settle the drawer at its end state with the transition on; SideMenu drops this override once `open` follows. */
function release(menu: RefObject<HTMLElement | null>, progress: number | null) {
  const node = menu.current;
  if (!node) return;
  if (progress === null) node.style.removeProperty('--side-menu-progress');
  else node.style.setProperty('--side-menu-progress', String(progress));
  node.removeAttribute('data-dragging');
}
function follow(menu: RefObject<HTMLElement | null>, progress: number) {
  const node = menu.current;
  if (!node) return;
  node.setAttribute('data-dragging', '');
  node.style.setProperty('--side-menu-progress', String(progress));
}

/** A swipe from the left edge drags the drawer open; the opposite swipe on it drags it shut. */
export function useSideMenuGestures({shell, menu, enabled, open, onOpen, onClose}: {
  shell: RefObject<HTMLElement | null>;
  menu: RefObject<HTMLElement | null>;
  /** The gesture may act at all: a phone session, the gesture switched on, no dialog over it. */
  enabled: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  useEdgeGestures({
    enabled: enabled && !open, edges: ['left'], target: shell,
    handlers: {
      onProgress: (_edge, progress) => follow(menu, progress),
      onCommit: () => { release(menu, 1); onOpen(); },
      onCancel: () => release(menu, 0),
    },
  });
  useSwipeToClose({
    enabled: enabled && open, direction: 'left', target: menu,
    onProgress: progress => follow(menu, 1 - progress),
    onCommit: () => { release(menu, 0); onClose(); },
    onCancel: () => release(menu, 1),
  });
}
