// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PreviewPanel, { parseAllowedPorts, parsePreview, previewNote } from './PreviewPanel';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));
const preview = { id: 'forward-one', remotePort: 5173, remoteAddress: '127.0.0.1', localPort: 41234, url: 'http://127.0.0.1:41234/' };
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });
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
  expect(invoke).not.toHaveBeenCalledWith('start_preview', expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
  const frame = await screen.findByTitle('Host browser preview on port 5173');
  expect(frame.getAttribute('src')).toBe(preview.url);
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin');
  expect(invoke).toHaveBeenCalledWith('start_preview', { sessionId: 'ssh-one', remotePort: 5173, remoteAddress: '127.0.0.1' });
  fireEvent.click(screen.getByRole('button', { name: 'Close preview 5173' }));
  await waitFor(() => expect(screen.queryByTitle('Host browser preview on port 5173')).toBeNull());
  expect(invoke).toHaveBeenCalledWith('stop_preview', { sessionId: 'ssh-one', previewId: preview.id });
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
  expect(invoke).toHaveBeenCalledWith('discover_preview_ports', { sessionId: 'ssh-one', allowPorts: [3000, 8000, 8001], probeHttp: true });
  expect(invoke).not.toHaveBeenCalledWith('start_preview', expect.anything());
});
it('stages a page note only after an explicit user action', async () => {
  vi.mocked(invoke).mockResolvedValue([preview]);
  const staged = vi.fn();
  window.addEventListener('lazysh-prompt-draft', staged);
  try {
    render(<PreviewPanel sessionId="ssh-one" />);
    await screen.findByTitle('Host browser preview on port 5173');
    fireEvent.change(screen.getByLabelText('Page path'), { target: { value: '/login' } });
    fireEvent.change(screen.getByLabelText('Element selector (optional)'), { target: { value: '#submit' } });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Increase contrast' } });
    expect(staged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stage note in prompt' }));
    expect(staged).toHaveBeenCalledOnce();
    const detail = (staged.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.sessionId).toBe('ssh-one');
    expect(detail.text).toContain('Page: /login\nElement: #submit\nComment: Increase contrast');
    expect(invoke).not.toHaveBeenCalledWith('write_stdin', expect.anything());
  } finally { window.removeEventListener('lazysh-prompt-draft', staged); }
});
