import {createRoot} from 'react-dom/client';
import HostBrowserPanel from '../../src/HostBrowserPanel';

declare global {interface Window {hostBrowserRelay: (command: string, args: unknown) => Promise<unknown>}}

/**
 * The real tool, canvas and JPEG decoding. Only the native bridge is replaced: each command goes to the spec's own
 * bridge (`window.hostBrowserRelay`), which runs the real `lazysh-agent host-browser serve`. A pulled message
 * crosses as base64 and becomes the ArrayBuffer that Tauri hands a raw response.
 */
export function mountHostBrowser() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {invoke: async (command: string, args: unknown) => {
    const answer = await window.hostBrowserRelay(command, args);
    return answer && typeof answer === 'object' && 'base64' in answer ? Uint8Array.from(atob(String(answer.base64)), character => character.charCodeAt(0)).buffer : answer;
  }}});
  const host = document.createElement('main');
  host.className = 'host-browser-fixture';
  host.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;background:var(--theme-bg,#000)';
  document.body.append(host);
  const root = createRoot(host);
  root.render(<HostBrowserPanel sessionId="host-browser-e2e"/>);
  return {dispose() { root.unmount(); host.remove(); }};
}
