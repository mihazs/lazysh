import {Keyboard,KeyboardOff,PanelBottomClose,PanelBottomOpen,PenOff,SquarePen,type LucideIcon} from 'lucide-react';
import {useEffect,useId,useRef,useState,type CSSProperties,type ReactNode,type RefObject} from 'react';
import {useEdgeGestureMode,useEdgeGestures,useSwipeToClose} from './edgeGestures';
import {t,useUi} from './i18n/core';
import './BottomMenu.css';

/** The width at which the app switches to its compact phone layout. */
export function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia?.('(max-width: 600px)').matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 600px)');
    if (!media) return;
    const update = () => setPhone(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return phone;
}

/** Screen-reader mode, or the swipe switched off in Preferences: the caller shows a visible button. */
export const useBottomMenuButton = () => useEdgeGestureMode('bottomMenu') === 'buttons';

export type BottomMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  composing: boolean;
  onToggleComposer: () => void;
  toolbarVisible: boolean;
  onToggleToolbar: () => void;
  /** The soft keyboard show/hide button; omitted where the platform has none. */
  keyboard?: {open: boolean; onToggle: () => void};
  disabled?: boolean;
};

function Item({icon: Icon, label, onClick, disabled}: {icon: LucideIcon; label: ReactNode; onClick: () => void; disabled?: boolean}) {
  // The terminal keeps its focus (and the soft keyboard) while a menu button is pressed.
  return <button type="button" className="bottom-menu-item" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={onClick}><Icon size={20} aria-hidden="true" />{label}</button>;
}

/**
 * The bottom menu of a connected phone session. It overlays the terminal, so the terminal
 * never resizes while it is open, and every action closes it. A swipe up from the bottom
 * edge drags it open under the finger; a swipe down closes it. The pill at the edge only
 * shows where the swipe starts and takes no touch, so it never covers a key or a terminal
 * line. Screen readers, and the swipe switched off in Preferences, get a visible button
 * (`useBottomMenuButton`) that opens the same menu.
 */
export default function BottomMenu({open, onOpenChange, composing, onToggleComposer, toolbarVisible, onToggleToolbar, keyboard, disabled}: BottomMenuProps) {
  useUi();
  const id = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // The swipe starts at the screen's bottom edge, which is the bottom of the app viewport.
  const screen = useRef<HTMLElement | null>(null);
  if (!screen.current) screen.current = document.querySelector<HTMLElement>('.app-viewport') ?? document.body;
  const gesture = !useBottomMenuButton();
  // How far the finger has revealed the sheet (0 to 1) while it is down, else null: the sheet follows it, then settles.
  const [drag, setDrag] = useState<number | null>(null);
  const settle = (reveal: boolean) => {setDrag(null); onOpenChange(reveal);};
  useEdgeGestures({enabled: !open, edges: ['bottom'], target: screen, handlers: {onProgress: (_edge, progress) => setDrag(progress), onCommit: () => settle(true), onCancel: () => settle(false)}});
  useSwipeToClose({enabled: open, direction: 'down', target: sheet, onProgress: progress => setDrag(1 - progress), onCommit: () => settle(false), onCancel: () => settle(true)});
  useEffect(() => {
    if (!open) return;
    // A keyboard or screen-reader user arrives from a button: move into the sheet, and back when it closes. A touch keeps the terminal focused.
    opener.current = document.activeElement instanceof HTMLButtonElement && !sheet.current?.contains(document.activeElement) ? document.activeElement : null;
    if (opener.current) sheet.current?.querySelector<HTMLElement>('.bottom-menu-item:not(:disabled)')?.focus();
    const escape = (event: KeyboardEvent) => {if (event.key === 'Escape') {event.stopPropagation(); onOpenChange(false);}};
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      if (sheet.current?.contains(document.activeElement)) opener.current?.focus();
      opener.current = null;
    };
  }, [open, onOpenChange]);
  const act = (run: () => void) => () => {onOpenChange(false); run();};
  const progress = drag ?? (open ? 1 : 0);
  return <>
    {gesture && <div className="bottom-menu-handle" aria-hidden="true" data-hidden={progress > 0 || undefined}><span /></div>}
    {progress > 0 && <div className="bottom-menu-scrim" aria-hidden="true" style={{'--bottom-menu-progress': progress} as CSSProperties} onPointerDown={() => onOpenChange(false)} />}
    <div ref={sheet} id={id} role="group" aria-label={t('bottomMenu')} className="bottom-menu" data-open={open} data-dragging={drag !== null || undefined} inert={!open && drag === null}
      style={{'--bottom-menu-progress': progress} as CSSProperties}>
      <button type="button" className="bottom-menu-grip" aria-label={t('bottomMenuClose')} onPointerDown={event => event.preventDefault()} onClick={() => onOpenChange(false)}><span aria-hidden="true" /></button>
      <div className="bottom-menu-items">
        <Item icon={composing ? PenOff : SquarePen} disabled={disabled} label={composing ? t('bottomMenuHideComposer') : t('bottomMenuShowComposer')} onClick={act(onToggleComposer)} />
        <Item icon={toolbarVisible ? PanelBottomClose : PanelBottomOpen} label={toolbarVisible ? t('bottomMenuHideToolbar') : t('bottomMenuShowToolbar')} onClick={act(onToggleToolbar)} />
        {keyboard && <Item icon={keyboard.open ? KeyboardOff : Keyboard} disabled={disabled} label={keyboard.open ? t('bottomMenuHideKeyboard') : t('bottomMenuShowKeyboard')} onClick={act(keyboard.onToggle)} />}
      </div>
    </div>
  </>;
}
