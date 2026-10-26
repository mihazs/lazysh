import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import PreviewPanel from '../../src/PreviewPanel';
const token = '11111111-1111-4111-8111-111111111111';
export function mountPreviewHarness() {
  const calls:{command:string;args:unknown}[]=[];
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async (command: string,args:unknown) => {
    calls.push({command,args});
    if (command === 'list_previews') return [{ id: 'fixture', remotePort: 5173, remoteAddress: '127.0.0.1', localPort: 41234, url: 'http://127.0.0.1:41234/', pickerToken: token }];
    throw new Error(`Unexpected native command: ${command}`);
  } } });
  function Harness() {
    const [draft, setDraft] = useState('');
    useEffect(() => {
      const stage = (event: Event) => setDraft((event as CustomEvent).detail.text);
      window.addEventListener('lazysh-prompt-draft', stage);
      return () => window.removeEventListener('lazysh-prompt-draft', stage);
    }, []);
    return <main><PreviewPanel sessionId="fixture-session" /><pre aria-label="Staged annotation draft">{draft}</pre></main>;
  }
  const container = document.createElement('div'); document.body.replaceChildren(container); createRoot(container).render(<Harness />);
  return {calls};
}
