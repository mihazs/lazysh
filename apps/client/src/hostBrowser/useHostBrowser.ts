import {type RefObject, useEffect, useRef, useState} from 'react';
import {useProtectedInvoke} from '../access';
import {captureUiError, LocalUiError, type UiErrorCause} from '../i18n/localError';
import {decodeRelayMessage} from './relayMessage';

export type HostBrowserPhase = 'connecting' | 'running' | 'paused' | 'closed' | 'failed';
export type HostBrowserPage = {title: string; url: string};
/** What a decoded frame needs: pixels to draw and a way to release them. */
export type Decoded = CanvasImageSource & {width: number; height: number; close?: () => void};
export type Decode = (jpeg: Uint8Array) => Promise<Decoded>;

const decodeJpeg: Decode = jpeg => createImageBitmap(new Blob([jpeg as BlobPart], {type: 'image/jpeg'}));
const clamp = (value: number) => Math.min(2048, Math.max(100, Math.round(value) || 0));

/** The page's size in CSS pixels is the stage's, within the relay's bounds (100 to 2048); scale 1 keeps frames small. */
export function viewportOf(stage: {clientWidth: number; clientHeight: number} | null) {
  return {width: clamp(stage?.clientWidth || 390), height: clamp(stage?.clientHeight || 700), scale: 1};
}

/**
 * Runs one host browser for the session while `run` is above zero: starts it, pulls its messages one at a time,
 * draws each frame on `canvas` and acknowledges it once it is drawn. While `visible` is false it pauses the relay
 * and neither draws nor acknowledges a frame that was already on its way. Leaving stops the browser.
 */
export function useHostBrowser({sessionId, canvas, stage, visible, decode = decodeJpeg}: {
  sessionId: string; canvas: RefObject<HTMLCanvasElement | null>; stage: RefObject<HTMLElement | null>; visible: boolean; decode?: Decode;
}) {
  const invoke = useProtectedInvoke();
  const [run, setRun] = useState(1);
  const [phase, setPhase] = useState<HostBrowserPhase>('connecting');
  const [page, setPage] = useState<HostBrowserPage>();
  const [drawn, setDrawn] = useState(false);
  const [ended, setEnded] = useState<{reason: string; detail?: string} | {error: UiErrorCause}>();
  const shown = useRef(visible);
  const current = useRef<{id: string; paused: boolean} | undefined>(undefined);
  const decoder = useRef(decode);
  decoder.current = decode;

  // A frame is judged by the document's own word as well as by the last render: the event that hides it comes first.
  const isShown = () => shown.current && document.visibilityState !== 'hidden';
  const tell = (command: string, id: string, extra?: Record<string, unknown>) =>
    invoke(command, {sessionId, browserId: id, ...extra}).catch(() => {});
  useEffect(() => {
    shown.current = visible;
    const browser = current.current;
    if (!browser || browser.paused === !visible) return;
    browser.paused = !visible;
    void tell(visible ? 'host_browser_resume' : 'host_browser_pause', browser.id);
  }, [visible]);

  useEffect(() => {
    setPage(undefined);
    setDrawn(false);
    setEnded(undefined);
    if (run === 0) { setPhase('closed'); setEnded({reason: 'Stopped'}); return; }
    setPhase('connecting');
    let cancelled = false;
    let token: string | undefined;
    const stop = () => { const id = token; token = undefined; current.current = undefined; if (id) void tell('host_browser_stop', id); };
    void (async () => {
      try {
        const id = await invoke<string>('host_browser_start', {sessionId, viewport: viewportOf(stage.current)});
        token = id;
        if (cancelled) return;
        current.current = {id, paused: !isShown()};
        if (!isShown()) void tell('host_browser_pause', id);
        while (!cancelled) {
          const message = decodeRelayMessage(await invoke<ArrayBuffer>('host_browser_next', {sessionId, browserId: id}));
          if (cancelled) break;
          if (message.kind === 'state') setPhase(message.run);
          else if (message.kind === 'page') setPage({title: message.title, url: message.url});
          else if (message.kind === 'closed') { setPhase('closed'); setEnded({reason: message.reason, ...message.detail === undefined ? {} : {detail: message.detail}}); break; }
          else if (message.kind === 'frame' && isShown()) {
            const started = performance.now();
            const bitmap = await decoder.current(message.jpeg).catch(() => { throw new LocalUiError('hostBrowserInvalidMessage'); });
            // A frame decoded after the view was hidden is dropped without an acknowledgement: resuming forgets it.
            if (cancelled || !isShown() || !canvas.current) { bitmap.close?.(); continue; }
            if (canvas.current.width !== bitmap.width || canvas.current.height !== bitmap.height) { canvas.current.width = bitmap.width; canvas.current.height = bitmap.height; }
            canvas.current.getContext('2d')?.drawImage(bitmap, 0, 0);
            bitmap.close?.();
            setDrawn(true);
            void tell('host_browser_ack', id, {sequence: message.sequence, decodeMs: Math.round(performance.now() - started)});
          }
        }
      } catch (failure) {
        if (!cancelled) { setPhase('failed'); setEnded({error: captureUiError(failure)}); }
      } finally {
        stop();
      }
    })();
    return () => { cancelled = true; stop(); };
  }, [sessionId, run]);

  // The relay's `running` is a promise of frames: the view is live once the first one is on the canvas.
  return {phase: phase === 'running' && !drawn ? 'connecting' as const : phase, drawn, page, ended, stop: () => setRun(0), restart: () => setRun(before => before + 1)};
}
