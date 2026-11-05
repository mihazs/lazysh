// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { isTauri } from '@tauri-apps/api/core';
import { api } from './bridge';
import { accessSnapshot, applyAccessStatus } from './access';
import { prepareClipboardPlatform } from './deviceClipboard';
import ThemeImportPanel from './ThemeImportPanel';
import { defaults } from './preferences';
import { t } from './i18n/core';
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(), invoke: vi.fn() }));
vi.mock('./bridge', () => ({ api: { clipboardIsAndroid: vi.fn(), clipboardRead: vi.fn(), clipboardCancel: vi.fn() } }));
const theme = JSON.stringify({ v: 1, name: 'Clipboard dusk', mode: 'dark', colors: { background: '#101820', foreground: '#f0f0f0' } });
const input = () => screen.getByLabelText<HTMLTextAreaElement>('Theme JSON or share code');
beforeEach(async () => {
  applyAccessStatus({ initialized: true, supported: true, enabled: true, reason: '', locked: false,
    generation: String(BigInt(accessSnapshot().status?.generation ?? '0') + 1n), nonce: 'e'.repeat(64) });
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(api.clipboardIsAndroid).mockResolvedValue(true); vi.mocked(api.clipboardCancel).mockResolvedValue();
  await prepareClipboardPlatform();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockRejectedValue(new Error('WebView denied')) } });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('reads the Android clipboard natively, previews the theme and applies it only after confirmation', async () => {
  vi.mocked(api.clipboardRead).mockResolvedValue({ kind: 'text', text: theme });
  const apply = vi.fn().mockReturnValue(true);
  render(<ThemeImportPanel preferences={defaults} apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read theme from clipboard' }));
  const preview = await screen.findByRole('region', { name: 'Theme preview' });
  expect(preview.querySelector('h3')?.textContent).toBe('Clipboard dusk');
  expect(api.clipboardRead).toHaveBeenCalledExactlyOnceWith({ token: expect.any(String), kind: 'text' });
  expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  expect(input().value).toBe(theme);
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply to app and terminal' }));
  expect(apply).toHaveBeenCalledExactlyOnceWith({ theme: 'custom', appTheme: 'custom',
    customTheme: expect.objectContaining({ background: '#101820', foreground: '#f0f0f0' }), customThemeInfo: { name: 'Clipboard dusk', mode: 'dark' } });
});

it.each([
  ['invalid JSON', 'not a theme', 'validationEnterValidThemeJSONOrAThemeShareCode', 'not a theme'],
  ['unsafe colors', '{"v":1,"name":"Unsafe","mode":"light","colors":{"background":"url(evil)","foreground":"#fff"}}', 'validationInvalidThemeColorValue1', null],
  ['oversized input', `{"name":"${'x'.repeat(17000)}"}`, 'validationThemeInputExceeds16KiB', ''],
] as const)('rejects %s from the native clipboard without a preview', async (_label, text, key, draft) => {
  vi.mocked(api.clipboardRead).mockResolvedValue({ kind: 'text', text });
  const apply = vi.fn();
  render(<ThemeImportPanel preferences={defaults} apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read theme from clipboard' }));
  const status = await screen.findByRole('status');
  expect(status.textContent).toBe(key === 'validationInvalidThemeColorValue1' ? t(key, { value1: 'background' }) : t(key));
  expect(screen.queryByRole('region', { name: 'Theme preview' })).toBeNull();
  if (draft !== null) expect(input().value).toBe(draft);
  expect(apply).not.toHaveBeenCalled();
});

it('reports an unreadable native clipboard and never falls back to the WebView clipboard', async () => {
  vi.mocked(api.clipboardRead).mockRejectedValue('clipboard_empty');
  render(<ThemeImportPanel preferences={defaults} apply={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read theme from clipboard' }));
  expect((await screen.findByRole('status')).textContent).toBe(t('themeClipboardCouldNotBeReadPasteTheThemeInto'));
  expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Read theme from clipboard' })).toHaveProperty('disabled', false);
});

it('ignores repeated clicks while a native read is held', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.clipboardRead).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<ThemeImportPanel preferences={defaults} apply={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'Read theme from clipboard' });
  fireEvent.click(button); fireEvent.click(button);
  expect(button).toHaveProperty('disabled', true);
  finish({ kind: 'text', text: theme });
  await screen.findByRole('region', { name: 'Theme preview' });
  expect(api.clipboardRead).toHaveBeenCalledTimes(1);
});
