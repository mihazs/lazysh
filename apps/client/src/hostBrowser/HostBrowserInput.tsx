import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { t, useUi } from '../i18n/core';
import type { FrameMetadata } from './cdp';
import { Gestures, keyMessage, noZoom, type InputMessage, type Zoom } from './input';
import './HostBrowserInput.css';

/**
 * The host browser's input: a **Control** switch that is off until the person turns it on, and while it is on touch,
 * scroll, pinch and the phone keyboard become input messages for `send`. While it is off nothing reaches `send`, whatever
 * the person touches or types. The displayed frame (`children`, one element that fills the width) can still be zoomed
 * locally, because that sends nothing.
 *
 * `active` says the view is live; Control goes off when it is not, so every session starts with Control off.
 * `frame` returns what the browser said about the frame on screen, which maps a point of it to a page pixel.
 */
export function HostBrowserInput({ active, frame, send, children }: {
  active: boolean; frame: () => FrameMetadata; send: (message: InputMessage) => void; children: ReactNode;
}) {
  useUi();
  const [control, setControl] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [zoom, setZoom] = useState<Zoom>(noZoom);
  const view = useRef<HTMLDivElement>(null);
  const sink = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ control, frame, send });
  latest.current = { control, frame, send };
  // The one place input leaves this component, and the one place Control is checked.
  const emit = (message: InputMessage) => { if (latest.current.control) latest.current.send(message); };
  const gestures = useRef<Gestures>(null);
  gestures.current ??= new Gestures({
    surface: () => {
      const box = view.current!.getBoundingClientRect();
      return { size: { width: box.width, height: box.height }, frame: latest.current.frame() };
    },
    send: emit,
    zoomed: setZoom,
  });
  const touch = gestures.current;

  const switchControl = (on: boolean) => {
    // The ref changes now, not after the next render, so a touch between the tap and the render is still refused.
    latest.current.control = on;
    setControl(on);
    if (!on) {
      touch.reset();
      touch.selecting = false;
      setSelecting(false);
      sink.current?.blur();
    }
  };
  useEffect(() => { if (!active) switchControl(false); }, [active]);
  useEffect(() => () => touch.reset(), [touch]);

  const at = (event: PointerEvent) => {
    const box = view.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const flushText = (field: HTMLTextAreaElement) => {
    const text = field.value;
    field.value = '';
    if (text) emit({ type: 'text', text });
  };

  return <div className="host-browser-input">
    <div className="host-browser-input-bar" role="group" aria-label={t('hostBrowserInputTools')}>
      <button type="button" role="switch" aria-checked={control} className="subtle-button" disabled={!active} onClick={() => switchControl(!control)}>{t('hostBrowserControl')}</button>
      <button type="button" aria-pressed={selecting} className="subtle-button" disabled={!control}
        onClick={() => { touch.selecting = !selecting; setSelecting(!selecting); }}>{t('hostBrowserSelect')}</button>
      <button type="button" className="subtle-button" disabled={!control} onClick={() => sink.current?.focus()}>{t('hostBrowserKeyboard')}</button>
      <button type="button" className="subtle-button" disabled={!control || zoom.scale === 1} onClick={() => touch.commit()}>{t('hostBrowserZoomPage')}</button>
    </div>
    <div ref={view} className="host-browser-viewport" onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        touch.down(event.pointerId, at(event));
      }}
      onPointerMove={event => touch.move(event.pointerId, at(event))}
      onPointerUp={event => touch.up(event.pointerId, event.timeStamp)}
      onPointerCancel={event => touch.up(event.pointerId, event.timeStamp, true)}>
      <div className="host-browser-zoom" style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}>{children}</div>
      {/* The phone keyboard types into this field; it holds nothing, because every character goes on to the page. */}
      <textarea ref={sink} className="host-browser-keyboard" aria-label={t('hostBrowserKeyboardInput')} rows={1}
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) flushText(event.currentTarget); }}
        onCompositionEnd={event => flushText(event.currentTarget)}
        onKeyDown={event => {
          // An IME's keys (a candidate chosen with Enter, for one) belong to the composition, not to the page.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          const message = keyMessage(event);
          if (message) { event.preventDefault(); emit(message); }
        }} />
    </div>
  </div>;
}
