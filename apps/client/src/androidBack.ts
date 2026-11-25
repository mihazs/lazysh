import {onBackButtonPress} from '@tauri-apps/api/app';

type BackListener = Awaited<ReturnType<typeof onBackButtonPress>>;

async function retire(listener: BackListener) {
  try {
    await listener.unregister();
  } finally {
    const tauri = (window as Window & {__TAURI_INTERNALS__?: {unregisterCallback(id: number): void}}).__TAURI_INTERNALS__;
    tauri?.unregisterCallback(listener.channelId);
  }
}

/** Native listener retirement does not release the Android WebView callback. */
export function watchAndroidBack(handle: () => void) {
  let callback: (() => void) | undefined = handle;
  const ready = onBackButtonPress(() => callback?.());
  void ready.catch(() => { callback = undefined; });
  return () => {
    callback = undefined;
    void ready.then(retire).catch(() => {});
  };
}
