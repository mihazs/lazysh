// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AttachmentPanel from './AttachmentPanel';
import { api } from './bridge';

vi.mock('./bridge', () => ({ api: { uploadFile: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function file(name = 'report.txt', content = 'hello') {
  const value = new File([content], name, { type: 'text/plain' });
  Object.defineProperty(value, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
  return value;
}
it('stages a private file, uploads only on explicit action, and exposes a quoted editable prompt', async () => {
  vi.mocked(api.uploadFile).mockResolvedValue(undefined);
  render(<AttachmentPanel sessionId="ssh-one" />);
  fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [file()] } });
  await screen.findByText(/report.txt · 5 bytes/);
  expect(api.uploadFile).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Destination path'), { target: { value: "/work/a'b.txt" } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  await screen.findByLabelText('Host path');
  expect(api.uploadFile).toHaveBeenCalledWith('ssh-one', "/work/a'b.txt", [104, 101, 108, 108, 111]);
  expect(screen.getByLabelText('Host path')).toHaveProperty('value', "'/work/a'\\''b.txt'");
  expect(screen.getByLabelText('Editable prompt')).toHaveProperty('value', "Please review the attached file '/work/a'\\''b.txt'.");
  fireEvent.change(screen.getByLabelText('Editable prompt'), { target: { value: 'My own prompt' } });
  expect(screen.getByLabelText('Editable prompt')).toHaveProperty('value', 'My own prompt');
  const staged = vi.fn(); window.addEventListener('lazysh-prompt-draft', staged);
  fireEvent.click(screen.getByRole('button', { name: 'Stage in terminal' }));
  expect(staged).toHaveBeenCalledOnce();
  expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'ssh-one', text: 'My own prompt' });
  window.removeEventListener('lazysh-prompt-draft', staged);
});
it('cancels before upload, rejects invalid destination, and reports native no-overwrite errors', async () => {
  vi.mocked(api.uploadFile).mockRejectedValue({ message: 'Remote file already exists' });
  render(<AttachmentPanel sessionId="ssh-one" />);
  fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [file()] } });
  await screen.findByLabelText('Destination path');
  fireEvent.change(screen.getByLabelText('Destination path'), { target: { value: '/a\tb' } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Enter a destination without control characters, no longer than 4096 characters.');
  expect(api.uploadFile).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Destination path'), { target: { value: '/exists' } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Remote file already exists'));
  expect(screen.queryByLabelText('Host path')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel attachment' }));
  expect(screen.queryByLabelText('Destination path')).toBeNull();
});
it('handles clipboard permission denial without automatic uploads', async () => {
  const read = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read } });
  render(<AttachmentPanel sessionId="ssh-one" />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Paste clipboard image' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Clipboard permission denied');
  expect(api.uploadFile).not.toHaveBeenCalled();
});

it('flattens an explicit crop to PNG before the bounded upload', async () => {
  const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); view.setUint32(12, 0x49484452); view.setUint32(16, 100); view.setUint32(20, 80);
  const image = new File([bytes], 'shot.png', { type: 'image/png' });
  Object.defineProperty(image, 'arrayBuffer', { value: async () => bytes.buffer });
  const context = { clearRect: vi.fn(), drawImage: vi.fn(), translate: vi.fn(), strokeRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Blob));
  vi.stubGlobal('Image', class {
    naturalWidth = 100; naturalHeight = 80; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:local-image') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.mocked(api.uploadFile).mockResolvedValue(undefined);
  render(<AttachmentPanel sessionId="ssh-one" />);
  fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [image] } });
  fireEvent.click(await screen.findByLabelText('Crop or annotate PNG/JPEG'));
  await waitFor(() => expect(context.drawImage).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Crop x'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Crop width'), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  await screen.findByLabelText('Host path');
  expect(context.translate).toHaveBeenCalledWith(-10, -0);
  expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  expect(api.uploadFile).toHaveBeenCalledWith('ssh-one', './shot-edited.png', [1, 2, 3]);
});
