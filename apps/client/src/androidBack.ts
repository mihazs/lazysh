import {onBackButtonPress} from '@tauri-apps/api/app';
import {invoke} from '@tauri-apps/api/core';

type BackListener = Awaited<ReturnType<typeof onBackButtonPress>>;

async function retire(listener: BackListener) {
  try {
    await listener.unregister();
  } finally {
    const tauri = (window as Window & {__TAURI_INTERNALS__?: {unregisterCallback(id: number): void}}).__TAURI_INTERNALS__;
    tauri?.unregisterCallback(listener.channelId);
  }
}

/**
 * Native listener retirement does not release the Android WebView callback. While a listener is registered AppPlugin never finishes
 * the activity, so `handle` returns false for a Back it has nothing to close and the default Back runs natively instead (#1578).
 */
export function watchAndroidBack(handle: () => boolean) {
  let callback: (() => boolean) | undefined = handle;
  const ready = onBackButtonPress(() => {
    if (callback?.() === false) void invoke('android_default_back').catch(() => {});
  });
  void ready.catch(() => { callback = undefined; });
  return () => {
    callback = undefined;
    void ready.then(retire).catch(() => {});
  };
}
