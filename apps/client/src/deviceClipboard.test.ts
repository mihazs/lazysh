// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { api } from './bridge';
import { applyAccessStatus, accessSnapshot } from './access';
import { checkPasteSize, readClipboardImage, readClipboardText } from './deviceClipboard';
import { attachmentPngHeader } from './test/attachmentData';
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(), invoke: vi.fn() }));
vi.mock('./bridge', () => ({ api: { clipboardIsAndroid: vi.fn(), clipboardRead: vi.fn(), clipboardCancel: vi.fn() } }));
function access(locked = false) {
  applyAccessStatus({ initialized: true, supported: true, enabled: true, reason: '', locked,
    generation: String(BigInt(accessSnapshot().status?.generation ?? '0') + 1n), ...(locked ? {} : { nonce: 'd'.repeat(64) }) });
}
beforeEach(() => {
  access(); vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(api.clipboardIsAndroid).mockResolvedValue(true); vi.mocked(api.clipboardCancel).mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockResolvedValue('browser'), read: vi.fn() } });
});
afterEach(() => { vi.resetAllMocks(); });
it('never treats malformed platform probes as permission for browser fallback', async () => {
  for (const value of [undefined, null, 0, '', 'false', {}]) {
    vi.mocked(api.clipboardIsAndroid).mockResolvedValue(value as boolean);
    await expect(readClipboardText(new AbortController().signal)).rejects.toThrow();
  }
  expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  expect(api.clipboardRead).not.toHaveBeenCalled();
});
it.each(['lock/unlock', 'abort'] as const)('does not start a browser read after a held unsupported-platform probe crosses %s', async change => {
  let finish!: (value: boolean) => void;
  vi.mocked(api.clipboardIsAndroid).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const owner = new AbortController(); const read = readClipboardText(owner.signal);
  const rejected = expect(read).rejects.toThrow();
  if (change === 'lock/unlock') { access(true); access(); } else owner.abort();
  finish(false); await rejected;
  expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  expect(api.clipboardRead).not.toHaveBeenCalled();
});
it('keeps browser reads on unsupported platforms and never falls back after Android rejection', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  expect(await readClipboardText(new AbortController().signal)).toBe('browser');
  expect(api.clipboardIsAndroid).not.toHaveBeenCalled();
  vi.mocked(isTauri).mockReturnValue(true); vi.mocked(api.clipboardIsAndroid).mockResolvedValue(false);
  expect(await readClipboardText(new AbortController().signal)).toBe('browser');
  vi.mocked(api.clipboardIsAndroid).mockResolvedValue(true); vi.mocked(api.clipboardRead).mockRejectedValue('clipboard_unavailable');
  await expect(readClipboardText(new AbortController().signal)).rejects.toThrow('Clipboard access was unavailable');
  expect(navigator.clipboard.readText).toHaveBeenCalledTimes(2);
});
it('returns literal text and checks UTF-8 plus the final bracketed-paste envelope without truncation', async () => {
  const text = '$literal\n世界'; vi.mocked(api.clipboardRead).mockResolvedValue({ kind: 'text', text });
  expect(await readClipboardText(new AbortController().signal)).toBe(text);
  expect(api.clipboardRead).toHaveBeenCalledExactlyOnceWith({ token: expect.any(String), kind: 'text' });
  expect(() => checkPasteSize('é'.repeat(32768))).not.toThrow();
  expect(() => checkPasteSize('x'.repeat(65524), true)).not.toThrow();
  expect(() => checkPasteSize('x'.repeat(65525), true)).toThrow();
  expect(() => checkPasteSize('é'.repeat(32769))).toThrow();
});
it('cancels only the original token and rejects a late result across lock and immediate unlock', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.clipboardRead).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const read = readClipboardText(new AbortController().signal); const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(api.clipboardRead).toHaveBeenCalledOnce());
  const { token } = vi.mocked(api.clipboardRead).mock.calls[0][0];
  access(true); access(); finish({ kind: 'text', text: 'stale private clipboard' });
  await rejected; expect(api.clipboardCancel).toHaveBeenCalledWith(token);
  expect(navigator.clipboard.readText).not.toHaveBeenCalled();
});
it('abort cancels a held native read and cannot return its payload', async () => {
  let finish!: (value: unknown) => void; const owner = new AbortController();
  vi.mocked(api.clipboardRead).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const read = readClipboardText(owner.signal); const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(api.clipboardRead).toHaveBeenCalledOnce());
  owner.abort(); finish({ kind: 'text', text: 'late' }); await rejected;
  expect(api.clipboardCancel).toHaveBeenCalledOnce();
});
it('stages a bounded verified PNG as a File and rejects mismatched, malformed and private extra fields', async () => {
  const bytes = btoa(String.fromCharCode(...attachmentPngHeader()));
  vi.mocked(api.clipboardRead).mockResolvedValue({ kind: 'image', mime: 'image/png', bytes });
  const file = await readClipboardImage(new AbortController().signal);
  expect(file.type).toBe('image/png'); expect(file.size).toBe(24);
  for (const payload of [
    { kind: 'image', mime: 'image/jpeg', bytes },
    { kind: 'image', mime: 'image/png', bytes: 'private provider error' },
    { kind: 'image', mime: 'image/png', bytes, uri: 'content://private' },
    { kind: 'image', mime: 'image/svg+xml', bytes },
    { kind: 'text', text: 'private', uri: 'content://private' },
  ]) {
    vi.mocked(api.clipboardRead).mockResolvedValue(payload);
    await expect(readClipboardImage(new AbortController().signal)).rejects.toThrow();
  }
  expect(navigator.clipboard.read).not.toHaveBeenCalled();
});
