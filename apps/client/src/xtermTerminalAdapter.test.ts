// @vitest-environment jsdom
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {runTerminalAdapterContract} from './terminalAdapter.contract';
import {XtermTerminalAdapter} from './xtermTerminalAdapter';
import {xtermContractHarness} from './xterm/contractHarness';
import {terminalEditorSelector, terminalRootSelector} from './terminalAdapter';
import {Terminal} from '@xterm/xterm';

beforeAll(() => {
  // jsdom has no matchMedia or canvas; xterm's DOM renderer needs only the former.
  window.matchMedia = ((query: string) => ({matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}})) as never;
});

runTerminalAdapterContract('xterm', xtermContractHarness);

describe('xterm backend specifics', () => {
  it('exposes the typed-input editor and the drawn screen once mounted, and measures nothing without layout', async () => {
    const adapter = new XtermTerminalAdapter(new Terminal({cols: 20, rows: 5}));
    expect(adapter.inputElement()).toBeUndefined();
    const element = document.createElement('div');
    document.body.append(element);
    await adapter.attach({kind: 'dom', element});
    expect(adapter.inputElement()).toBeInstanceOf(HTMLTextAreaElement);
    expect(adapter.screenElement()?.classList.contains('xterm-screen')).toBe(true);
    // App code finds the editor and the root through these markers, not through xterm's class names.
    expect(adapter.inputElement()!.matches(terminalEditorSelector)).toBe(true);
    expect(element.querySelector(terminalRootSelector)).toBe(element.firstElementChild);
    // jsdom lays nothing out: no proposal, no row height, and fitting or re-syncing the view changes nothing.
    expect(adapter.proposeSize()).toBeUndefined();
    expect(adapter.layoutRowHeight()).toBe(0);
    adapter.fit(); adapter.syncViewport();
    expect(adapter.size()).toEqual({columns: 20, rows: 5});
    await adapter.detach();
    expect(element.querySelector('.xterm')).toBeNull();
    await adapter.attach({kind: 'dom', element});
    expect(element.querySelector('.xterm')).not.toBeNull();
    await adapter.dispose();
  });

  it('retires its display-scale subscription with the renderer', async () => {
    const addListener = vi.fn(), removeListener = vi.fn();
    const matchMedia = window.matchMedia;
    const query = vi.spyOn(window, 'matchMedia').mockImplementation(value => ({
      ...matchMedia(value),
      addListener,
      removeListener,
    }));
    const adapter = await xtermContractHarness.create();
    try {
      await adapter.attach(xtermContractHarness.target());
      expect(query).toHaveBeenCalledWith(expect.stringContaining('resolution:'));
      expect(addListener).toHaveBeenCalledOnce();
      await adapter.dispose();
      expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0][0]);
    } finally {
      query.mockRestore();
      await adapter.dispose();
    }
  });

  it('delivers a wheel notch to the mounted element', async () => {
    const adapter = new XtermTerminalAdapter(new Terminal({cols: 20, rows: 5}));
    const element = document.createElement('div');
    document.body.append(element);
    await adapter.attach({kind: 'dom', element});
    const seen: WheelEvent[] = [];
    element.addEventListener('wheel', event => seen.push(event as WheelEvent));
    adapter.wheel({clientX: 3, clientY: 4, deltaY: -2, unit: 'line'});
    expect(seen.map(event => [event.clientX, event.clientY, event.deltaY, event.deltaMode])).toEqual([[3, 4, -2, WheelEvent.DOM_DELTA_LINE]]);
    await adapter.dispose();
  });

  it('refuses a native mount target', async () => {
    const adapter = new XtermTerminalAdapter(new Terminal());
    await expect(adapter.attach({kind: 'native', anchorId: 'x'})).rejects.toThrow('DOM');
    await adapter.dispose();
    expect(adapter.capabilities.nativeRendering).toBe(false);
  });
});
