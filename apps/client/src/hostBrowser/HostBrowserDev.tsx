import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostBrowserSession, pagePoint, parseEndpoint, specialKey, type Frame, type FrameMetadata } from './cdp';
import { HostBrowserControls } from './HostBrowserControls';
import { emptyView, type Blocked, type PageDialog, type View } from './model';

const SIZE = { width: 390, height: 700 };
type Stats = { frames: number; fps: number; tapToChangeMs: number | null };

/** Eight sampled pixels: enough to notice that a tap changed what the page shows. */
function signature(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const points = [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1], [0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.1, 0.9], [0.9, 0.9]];
  return points.map(([x, y]) => context.getImageData(Math.floor(x * (canvas.width - 1)), Math.floor(y * (canvas.height - 1)), 1, 1).data.join(',')).join(';');
}

/**
 * Developer prototype: shows the page of a Chrome-family browser through a loopback DevTools endpoint (the
 * SSH-forwarded port) and sends taps and keys. Mounted only by the Vite dev server; see docs/host-browser.md.
 */
export function HostBrowserDev() {
  const [endpoint, setEndpoint] = useState('');
  const [state, setState] = useState('idle');
  const [stats, setStats] = useState<Stats>({ frames: 0, fps: 0, tapToChangeMs: null });
  const [view, setView] = useState<View>(emptyView);
  const [dialog, setDialog] = useState<PageDialog | null>(null);
  const [blocked, setBlocked] = useState<Blocked[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sink = useRef<HTMLTextAreaElement>(null);
  const session = useRef<HostBrowserSession | null>(null);
  const last = useRef<FrameMetadata>({ deviceWidth: SIZE.width, deviceHeight: SIZE.height, offsetTop: 0, timestamp: 0 });
  const tap = useRef<{ at: number; before: string } | null>(null);
  const arrivals = useRef<number[]>([]);
  const frames = useRef(0);
  const tapToChangeMs = useRef<number | null>(null);

  async function draw({ jpeg, metadata }: Frame, acknowledge: () => void) {
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    const target = canvas.current!;
    if (target.width !== bitmap.width) { target.width = bitmap.width; target.height = bitmap.height; }
    target.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
    bitmap.close();
    acknowledge();
    last.current = metadata;
    const now = performance.now();
    arrivals.current = [...arrivals.current.filter(time => now - time < 1000), now];
    frames.current++;
    if (tap.current && signature(target) !== tap.current.before) { tapToChangeMs.current = now - tap.current.at; tap.current = null; }
    setStats({ frames: frames.current, fps: arrivals.current.length, tapToChangeMs: tapToChangeMs.current });
  }

  async function connect() {
    try {
      setState('connecting');
      session.current = await HostBrowserSession.connect(parseEndpoint(endpoint), () => setState('closed'));
      // A kind is reported once until it is dismissed, however many times the page tries.
      session.current.listener = { view: setView, dialog: setDialog, blocked: kind => setBlocked(kinds => (kinds.includes(kind) ? kinds : [...kinds, kind])) };
      await session.current.start(SIZE, (frame, acknowledge) => void draw(frame, acknowledge));
      setState('live');
    } catch (error) { setState(`failed: ${(error as Error).message}`); }
  }
  useEffect(() => () => void session.current?.close(), []);

  function press(event: React.PointerEvent<HTMLCanvasElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    tap.current = { at: performance.now(), before: signature(event.currentTarget) };
    void session.current?.tap(pagePoint({ x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }, last.current));
  }

  return <main style={{ font: '14px system-ui', padding: 12, maxWidth: 480 }}>
    <h1 style={{ fontSize: 16 }}>Host browser prototype (developer only)</h1>
    <label>DevTools WebSocket URL <input style={{ width: '100%' }} value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="ws://127.0.0.1:9222/devtools/browser/…" /></label>
    <p><button onClick={() => void connect()} disabled={state === 'connecting' || state === 'live'}>Connect</button>{' '}
      <button onClick={() => sink.current?.focus()} disabled={state !== 'live'}>Keyboard</button></p>
    <p role="status" id="hb-state">{state}</p>
    {session.current && state === 'live' && <HostBrowserControls view={view} dialog={dialog} blocked={blocked} navigation={session.current}
      onDismiss={kind => setBlocked(kinds => kinds.filter(item => item !== kind))} />}
    <canvas ref={canvas} aria-label="Host browser page" onPointerDown={press} style={{ width: '100%', border: '1px solid #888', touchAction: 'none' }} width={SIZE.width} height={SIZE.height} />
    <textarea ref={sink} aria-label="Keyboard input" style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }} autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onInput={event => { const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) void session.current?.text(text); }}
      onKeyDown={event => { if (specialKey(event.key)) { event.preventDefault(); void session.current?.key(event.key); } }} />
    <pre id="hb-stats">{JSON.stringify(stats)}</pre>
  </main>;
}

export function mountHostBrowserDev(root: HTMLElement) { createRoot(root).render(<HostBrowserDev />); }
