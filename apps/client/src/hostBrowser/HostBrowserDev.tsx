import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostBrowserSession, parseEndpoint, type Frame, type FrameMetadata } from './cdp';
import { HostBrowserInput } from './HostBrowserInput';
import type { InputMessage } from './input';

const SIZE = { width: 390, height: 700 };
/** `scrollY` and `pageScale` are what the browser reported in the latest frame, not what was sent. */
type Stats = { frames: number; fps: number; tapToChangeMs: number | null; scrollY: number; pageScale: number };

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
  const [stats, setStats] = useState<Stats>({ frames: 0, fps: 0, tapToChangeMs: null, scrollY: 0, pageScale: 1 });
  const canvas = useRef<HTMLCanvasElement>(null);
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
    setStats({ frames: frames.current, fps: arrivals.current.length, tapToChangeMs: tapToChangeMs.current, scrollY: metadata.scrollOffsetY ?? 0, pageScale: metadata.pageScaleFactor ?? 1 });
  }

  async function connect() {
    try {
      setState('connecting');
      session.current = await HostBrowserSession.connect(parseEndpoint(endpoint), () => setState('closed'));
      await session.current.start(SIZE, (frame, acknowledge) => void draw(frame, acknowledge));
      setState('live');
    } catch (error) { setState(`failed: ${(error as Error).message}`); }
  }
  useEffect(() => () => void session.current?.close(), []);

  function send(message: InputMessage) {
    if (message.type === 'pointer' && message.kind === 'press') tap.current = { at: performance.now(), before: signature(canvas.current!) };
    void session.current?.input(message).catch(() => {});
  }

  return <main style={{ font: '14px system-ui', padding: 12, maxWidth: 480 }}>
    <h1 style={{ fontSize: 16 }}>Host browser prototype (developer only)</h1>
    <label>DevTools WebSocket URL <input style={{ width: '100%' }} value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="ws://127.0.0.1:9222/devtools/browser/…" /></label>
    <p><button onClick={() => void connect()} disabled={state === 'connecting' || state === 'live'}>Connect</button></p>
    <p role="status" id="hb-state">{state}</p>
    <HostBrowserInput active={state === 'live'} frame={() => last.current} send={send}>
      <canvas ref={canvas} aria-label="Host browser page" width={SIZE.width} height={SIZE.height} />
    </HostBrowserInput>
    <pre id="hb-stats">{JSON.stringify(stats)}</pre>
  </main>;
}

export function mountHostBrowserDev(root: HTMLElement) { createRoot(root).render(<HostBrowserDev />); }
