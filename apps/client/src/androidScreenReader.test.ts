// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const app = vi.hoisted(() => ({invoke: vi.fn(), tauri: true}));
vi.mock('@tauri-apps/api/core', () => ({invoke: app.invoke, isTauri: () => app.tauri}));
import {systemScreenReader} from './androidScreenReader';

const userAgent = (value: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(value);
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';

beforeEach(() => { app.invoke.mockReset(); app.tauri = true; });
afterEach(() => vi.restoreAllMocks());

describe('the screen reader Android reports', () => {
  it('is what the app answers on Android, asked each time', async () => {
    userAgent(android);
    app.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect([await systemScreenReader(), await systemScreenReader()]).toEqual([true, false]);
    expect(app.invoke.mock.calls).toEqual([['screen_reader_active'], ['screen_reader_active']]);
  });

  it('counts an Android app that cannot answer, or answers something else, as having one', async () => {
    userAgent(android);
    app.invoke.mockRejectedValueOnce('screen_reader_unavailable').mockResolvedValueOnce(undefined).mockResolvedValueOnce('no');
    expect([await systemScreenReader(), await systemScreenReader(), await systemScreenReader()]).toEqual([true, true, true]);
  });

  it('asks the packaged Linux app for the accessibility status', async () => {
    userAgent('Mozilla/5.0 (X11; Linux x86_64)');
    app.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect([await systemScreenReader(), await systemScreenReader()]).toEqual([true, false]);
  });

  it('is no, without asking the app, anywhere else', async () => {
    userAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36');
    expect(await systemScreenReader()).toBe(false);
    userAgent(android);
    app.tauri = false;
    expect(await systemScreenReader()).toBe(false);
    expect(app.invoke).not.toHaveBeenCalled();
  });
});
