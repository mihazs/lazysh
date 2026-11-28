import { readFileSync } from 'node:fs';

/**
 * The browser WebSocket endpoint in a `DevToolsActivePort` file: the port on the first line, the path on the second.
 * A file that is still being written (no file, an empty file, only the port) is not an endpoint yet.
 */
export function parseDevToolsEndpoint(text: string): string | undefined {
  const [port, path] = text.split('\n');
  return /^\d+$/.test(port ?? '') && path?.startsWith('/') ? `ws://127.0.0.1:${port}${path}` : undefined;
}

/** Polls `file` until it holds both lines, so a partly written file never gives `ws://127.0.0.1:undefined`. */
export async function waitForDevToolsEndpoint(file: string, timeoutMs = 20000): Promise<string> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { /* not created yet */ }
    const endpoint = parseDevToolsEndpoint(text);
    if (endpoint) return endpoint;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${file} never held a port and a browser path`);
}
