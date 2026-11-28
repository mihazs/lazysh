// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {onBackButtonPress} from '@tauri-apps/api/app';
import {invoke} from '@tauri-apps/api/core';
import {watchAndroidBack} from './androidBack';

vi.mock('@tauri-apps/api/app', () => ({onBackButtonPress: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn().mockResolvedValue(undefined)}));
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

it('retires the WebView callback even when the native listener resolves after teardown', async () => {
  let register!: (listener: Awaited<ReturnType<typeof onBackButtonPress>>) => void;
  vi.mocked(onBackButtonPress).mockReturnValueOnce(new Promise(resolve => {register = resolve;}));
  const unregisterCallback = vi.fn();
  Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {unregisterCallback}});
  const handle = vi.fn(() => true);
  const stop = watchAndroidBack(handle);
  const callback = vi.mocked(onBackButtonPress).mock.calls[0][0];
  stop();
  callback({canGoBack: false});
  expect(handle).not.toHaveBeenCalled();

  const unregister = vi.fn().mockRejectedValue(new Error('already removed'));
  register({plugin: 'app', event: 'back-button', channelId: 17, unregister});
  await vi.waitFor(() => expect(unregisterCallback).toHaveBeenCalledWith(17));
  expect(unregister).toHaveBeenCalledOnce();
});

it('runs the native default Back for a Back the page has nothing to close', () => {
  vi.mocked(onBackButtonPress).mockReturnValueOnce(new Promise(() => {}));
  let open = false;
  watchAndroidBack(() => open);
  const callback = vi.mocked(onBackButtonPress).mock.calls.at(-1)![0];
  callback({canGoBack: false});
  expect(invoke).toHaveBeenCalledWith('android_default_back');
  vi.mocked(invoke).mockClear();
  open = true;
  callback({canGoBack: false});
  expect(invoke).not.toHaveBeenCalled();
});
