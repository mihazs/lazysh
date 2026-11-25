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

  it.each(['iPhone', 'iPad desktop mode'])('queries VoiceOver on packaged iOS (%s)', async (device) => {
    userAgent(device === 'iPhone' ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)');
    if (device !== 'iPhone') {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
      Object.defineProperty(navigator, 'maxTouchPoints', {configurable: true, value: 5});
    }
    try {
      app.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce('unavailable');
      expect([await systemScreenReader(), await systemScreenReader(), await systemScreenReader()]).toEqual([true, false, true]);
    } finally {
      Reflect.deleteProperty(navigator, 'maxTouchPoints');
    }
  });

  it('queries AppKit VoiceOver only in the packaged macOS app', async () => {
    userAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)');
    app.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect([await systemScreenReader(), await systemScreenReader()]).toEqual([true, false]);
    app.tauri = false;
    expect(await systemScreenReader()).toBe(false);
    expect(app.invoke).toHaveBeenCalledTimes(2);
  });

  it('is no, without asking the app, anywhere else', async () => {
    userAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36');
    expect(await systemScreenReader()).toBe(false);
    userAgent(android);
    app.tauri = false;
    expect(await systemScreenReader()).toBe(false);
    expect(app.invoke).not.toHaveBeenCalled();
  });
});
