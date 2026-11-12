// @vitest-environment jsdom
import {beforeAll, describe, expect, it} from 'vitest';
import {runTerminalAdapterContract} from './terminalAdapter.contract';
import {XtermTerminalAdapter} from './xtermTerminalAdapter';
import {Terminal} from '@xterm/xterm';

beforeAll(() => {
  // jsdom has no matchMedia or canvas; xterm's DOM renderer needs only the former.
  window.matchMedia = ((query: string) => ({matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}})) as never;
});

runTerminalAdapterContract('xterm', {
  create: () => new XtermTerminalAdapter(new Terminal({cols: 20, rows: 5, scrollback: 200, allowProposedApi: false})),
  target: () => { const element = document.createElement('div'); document.body.append(element); return {kind: 'dom', element}; },
});

describe('xterm backend specifics', () => {
  it('refuses a native mount target', async () => {
    const adapter = new XtermTerminalAdapter(new Terminal());
    await expect(adapter.attach({kind: 'native', anchorId: 'x'})).rejects.toThrow('DOM');
    await adapter.dispose();
    expect(adapter.capabilities.nativeRendering).toBe(false);
  });
});
