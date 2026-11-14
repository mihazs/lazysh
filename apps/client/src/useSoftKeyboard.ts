import {useEffect, useRef, useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {useProtectedInvoke} from './access';
import {touchScreen} from './softKeyboard';

/** The smallest viewport loss that is a keyboard rather than a toolbar or an address bar settling. */
const MIN_COVER = 120;

/**
 * Whether an on-screen keyboard covers the page: the viewport lost at least `MIN_COVER` px of the tallest
 * height seen at this width. Android resizes the web view for its keyboard and iOS shrinks the visual
 * viewport, so both show up here; Android also reports the keyboard itself, which wins when it answers.
 * shortcut: a keyboard already up before the page loads looks like the full height, and a floating
 * keyboard covers nothing; Android's own answer fixes both, iOS has none, so upgrade if iOS needs it.
 */
export function keyboardCovers(tallest: number, height: number) {
  return tallest - height >= MIN_COVER;
}

const viewportHeight = () => window.visualViewport?.height ?? window.innerHeight;

/** The real soft keyboard state of a touch device, and the calls that show or hide it. `open` is null on desktop. */
export function useSoftKeyboard() {
  const invoke = useProtectedInvoke();
  const [open, setOpen] = useState<boolean | null>(touchScreen() ? false : null);
  const alive = useRef(true);
  const reread = useRef<() => void>(() => {});
  useEffect(() => {
    alive.current = true;
    if (!touchScreen()) return () => {alive.current = false;};
    let tallest = viewportHeight(), width = window.innerWidth, request = 0;
    const settle = () => {
      if (window.innerWidth !== width) {width = window.innerWidth; tallest = 0;}
      const height = viewportHeight();
      tallest = Math.max(tallest, height);
      const proxy = keyboardCovers(tallest, height), mine = ++request;
      const settled = (visible: boolean) => {if (alive.current && mine === request) setOpen(visible);};
      if (!isTauri()) {settled(proxy); return;}
      // Android answers with the IME state; elsewhere the call returns null and the viewport decides.
      invoke<boolean | null>('soft_keyboard', {action: 'status'}).then(visible => settled(typeof visible === 'boolean' ? visible : proxy), () => settled(proxy));
    };
    const viewport = window.visualViewport;
    reread.current = settle;
    window.addEventListener('resize', settle);
    viewport?.addEventListener('resize', settle);
    return () => {
      alive.current = false;
      window.removeEventListener('resize', settle); viewport?.removeEventListener('resize', settle);
    };
  }, [invoke]);
  /**
   * Asks Android to show or hide its keyboard once the page has moved focus; other platforms follow focus alone.
   * The keyboard may open without resizing the page (beside a hardware keyboard), so its state is read again after the animation.
   */
  const request = (visible: boolean) => {
    if (!isTauri() || !touchScreen()) return;
    void invoke('soft_keyboard', {action: visible ? 'show' : 'hide'}).then(() => {setTimeout(() => {if (alive.current) reread.current();}, 350);}, () => {});
  };
  return {open, request};
}
