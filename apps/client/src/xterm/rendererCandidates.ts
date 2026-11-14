import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export type RendererCandidate = 'dom' | 'canvas' | 'webgl';

/** Loads a candidate's renderer addon on an opened xterm terminal, for the renderer shootout (#1323); `onContextLoss` runs when WebGL silently falls back to the DOM renderer. */
export function attachRendererCandidate(terminal: Terminal, candidate: RendererCandidate, onContextLoss: () => void) {
  if (candidate === 'canvas') terminal.loadAddon(new CanvasAddon());
  if (candidate === 'webgl') {
    const addon = new WebglAddon();
    addon.onContextLoss(() => { onContextLoss(); addon.dispose(); });
    terminal.loadAddon(addon);
  }
}
