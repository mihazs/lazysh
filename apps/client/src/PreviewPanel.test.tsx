// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PreviewPanel, { parseAllowedPorts, parsePreview, previewNote } from './PreviewPanel';
import { invoke } from '@tauri-apps/api/core';
import { uiI18n } from './i18n/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));
const preview = { id: 'forward-one', remotePort: 5173, remoteAddress: '127.0.0.1', localPort: 41234, url: 'http://127.0.0.1:41234/' };
afterEach(async () => { cleanup(); vi.resetAllMocks(); localStorage.clear(); await uiI18n.changeLanguage('en'); });
it('validates bounded explicit discovery allowlists', () => {
  expect(parseAllowedPorts('all')).toBeNull();
  expect(parseAllowedPorts('none')).toEqual([]);
  expect(parseAllowedPorts('3000,8000-8002,3000')).toEqual([3000, 8000, 8001, 8002]);
  for (const value of ['', '0', '65536', '3-1', '1-65535', 'all,22', '22;evil']) expect(() => parseAllowedPorts(value)).toThrow();
});
it('bounds manual review notes and rejects terminal control sequences', () => {
  expect(previewNote(3000, '/login', '#submit', 'Increase contrast')).toContain('Element: #submit\nComment: Increase contrast');
  expect(() => previewNote(3000, 'https://example.com', '', 'note')).toThrow();
  expect(() => previewNote(3000, '/', '', '\x1b[2J')).toThrow();
  expect(() => previewNote(3000, '/', '', 'a'.repeat(4001))).toThrow();
});
it('rejects non-loopback, script, malformed and port-mismatched preview URLs', () => {
  expect(parsePreview(preview)).toEqual(preview);
  for (const url of ['javascript:alert(1)', 'http://evil.example/', 'http://127.0.0.1:9/', 'http://127.0.0.1:41234/@evil']) expect(() => parsePreview({ ...preview, url })).toThrow();
  expect(() => parsePreview({ ...preview, remotePort: 65536 })).toThrow();
});
it('requires explicit selection and opens a sandboxed loopback frame without navigation permission', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'list_previews' ? [] : command === 'start_preview' ? preview : undefined);
  render(<PreviewPanel sessionId="ssh-one" />);
  await screen.findByText('Open your development server.');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Open preview' }) as HTMLButtonElement).disabled).toBe(false));
  expect(invoke).not.toHaveBeenCalledWith('start_preview', expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
  fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
  const frame = await screen.findByTitle('Host browser preview on port 5173');
  expect(frame.getAttribute('src')).toBe(preview.url);
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin');
  expect(invoke).toHaveBeenCalledWith('start_preview', { sessionId: 'ssh-one', remotePort: 5173, remoteAddress: '127.0.0.1' }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  fireEvent.click(screen.getByRole('button', { name: 'Close preview 5173' }));
  await waitFor(() => expect(screen.queryByTitle('Host browser preview on port 5173')).toBeNull());
  expect(invoke).toHaveBeenCalledWith('stop_preview', { sessionId: 'ssh-one', previewId: preview.id }, { headers: { "X-Lazysh-Access": expect.any(String) } });
});
it('rejects invalid ports without invoking native forwarding', async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  render(<PreviewPanel sessionId="ssh-one" />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Open preview' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Enter a port from 1 to 65535.');
  expect(vi.mocked(invoke).mock.calls.every(([command]) => command === 'list_previews')).toBe(true);
});
it('shows actual listener process metadata and applies only the explicit allowlist', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'list_previews' ? [] : [{ port: 3000, address: '127.0.0.1', process: 'node', pid: 123, http: true }]);
  render(<PreviewPanel sessionId="ssh-one" />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Discover listeners' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Discover ports'), { target: { value: '3000,8000-8001' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /Check for HTTP/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Discover listeners' }));
  expect(await screen.findByRole('button', { name: 'node (123) · 127.0.0.1:3000 · HTTP' })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith('discover_preview_ports', { sessionId: 'ssh-one', allowPorts: [3000, 8000, 8001], probeHttp: true }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(invoke).not.toHaveBeenCalledWith('start_preview', expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
});

async function discoverFramework(framework: unknown, http = true) {
  vi.mocked(invoke).mockImplementation(async command => command === 'list_previews' ? [] : [{ port: 3000, address: '127.0.0.1', process: 'node', pid: 123, http, framework }]);
  render(<PreviewPanel sessionId="ssh-one" />);
  const discover = screen.getByRole('button', { name: 'Discover listeners' });
  await waitFor(() => expect((discover as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('checkbox', { name: /Check for HTTP/ }));
  fireEvent.click(discover);
}
it('shows the finite Next.js server hint without automatically opening it', async () => {
  await discoverFramework('nextJs');
  expect(await screen.findByRole('button', { name: /node.*Next.js/ })).toBeTruthy();
  expect(screen.getByTitle('Server-reported framework hint')).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith('discover_preview_ports', { sessionId: 'ssh-one', allowPorts: null, probeHttp: true }, { headers: { 'X-Lazysh-Access': expect.any(String) } });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'start_preview')).toBe(false);
});
it.each(['vite', '<script>raw</script>', 1, {}, ['nextJs']])('rejects non-enumerated framework metadata %j', async framework => {
  await discoverFramework(framework);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid listener list.');
  expect(screen.queryByRole('button', { name: /127.0.0.1:3000/ })).toBeNull();
});
it('rejects a framework hint without a successful HTTP observation', async () => {
  await discoverFramework('nextJs', false);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid listener list.');
});

it('keeps the catalogued Next.js brand and original listener across locale changes without discovery or forwarding', async () => {
  await discoverFramework('nextJs');
  const button = await screen.findByRole('button', { name: /node.*Next.js/ });
  const calls = [...vi.mocked(invoke).mock.calls];
  for (const [locale, title] of [
    ['pt-BR', 'Indicação de framework informada pelo servidor'],
    ['es', 'Indicio de framework declarado por el servidor'],
    ['en', 'Server-reported framework hint'],
  ]) {
    await act(async () => { await uiI18n.changeLanguage(locale); });
    const hint = screen.getByTitle(title);
    expect(hint.textContent).toBe(' · Next.js');
    expect(hint.closest('button')).toBe(button);
    expect(vi.mocked(invoke).mock.calls).toEqual(calls);
  }
});
