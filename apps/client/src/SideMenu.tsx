import './SideMenu.css';
import {type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef} from 'react';
import {X} from 'lucide-react';
import {t, useUi} from './i18n/core';
import {cycleFocus, focusableWithin} from './focus';

/**
 * The phone side menu: a drawer over the session that holds what the top bar used to offer.
 * It never resizes the terminal. `--side-menu-progress` (0 closed, 1 open) positions it; the
 * gesture code writes that on `rootRef` while a finger drags, and `open` settles it otherwise.
 */
export function SideMenu({open, onClose, rootRef, children}: {
  open: boolean;
  onClose: () => void;
  rootRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  useUi();
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // A finished drag leaves its position on the element; once `open` has followed, the stylesheet decides again.
  useLayoutEffect(() => {
    rootRef.current?.style.removeProperty('--side-menu-progress');
    rootRef.current?.removeAttribute('data-dragging');
  }, [open, rootRef]);
  useEffect(() => {
    const node = panel.current;
    if (!open || !node) return;
    const previous = document.activeElement as HTMLElement | null;
    focusableWithin(node)[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      cycleFocus(event, focusableWithin(node));
    };
    // Back closes the drawer, as it closes a dialog: the event is the workspace's Back.
    const back = (event: Event) => { event.preventDefault(); closeRef.current(); };
    node.addEventListener('keydown', keydown);
    window.addEventListener('lazysh-workspace-back', back);
    return () => {
      node.removeEventListener('keydown', keydown);
      window.removeEventListener('lazysh-workspace-back', back);
      // Never hand focus back to the terminal: on a phone that raises the soft keyboard.
      if (previous?.isConnected && !previous.closest('.terminal-canvas')) previous.focus();
    };
  }, [open]);
  return <div ref={rootRef} className="side-menu" data-testid="side-menu" data-open={open}>
    <button type="button" className="side-menu-scrim" tabIndex={-1} aria-hidden="true" onClick={onClose} />
    <aside ref={panel} className="side-menu-panel" role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label={t('sideMenuTitle')} inert={!open}>
      <div className="side-menu-bar">
        <h2>{t('sideMenuTitle')}</h2>
        <button type="button" className="icon-button" aria-label={t('sideMenuClose')} title={t('sideMenuClose')} onClick={onClose}><X size={20} aria-hidden="true" /></button>
      </div>
      <div className="side-menu-scroll workspace-tools-content">{children}</div>
    </aside>
  </div>;
}

export function SideMenuSection({id, title, children}: {id: string; title: string; children: ReactNode}) {
  return <section className="side-menu-section" data-testid={`side-menu-${id}`} aria-label={title}>
    <h3>{title}</h3>
    {children}
  </section>;
}

/** Closes the menu after any click inside, including the terminal controls that React portals into it: those bubble through the terminal in the React tree, so only a DOM listener sees them. */
export function SideMenuChoices({onChoose, children}: {onChoose: () => void; children: ReactNode}) {
  const node = useRef<HTMLDivElement>(null);
  const choose = useRef(onChoose);
  choose.current = onChoose;
  useEffect(() => {
    const element = node.current;
    const click = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest('button')) choose.current(); };
    element?.addEventListener('click', click);
    return () => element?.removeEventListener('click', click);
  }, []);
  return <div ref={node} className="side-menu-choices">{children}</div>;
}
