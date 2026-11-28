import {isTauri} from '@tauri-apps/api/core';
import {useEffect, useState} from 'react';
import {useProtectedInvoke} from './access';

/** `pending` until the app answers; `unknown` when it cannot say (browser, failed or malformed reply). */
export type OptionAsMetaSupport = 'pending' | 'supported' | 'unsupported' | 'unknown';

/**
 * Option as Meta only changes xterm.js on macOS. The app reports its OS through `local_capability`,
 * because `navigator.platform` and user agents are not a contract. When the OS is unknown the
 * control stays (its label names macOS) so a guess never hides a setting that works.
 */
export function useOptionAsMetaSupport(): OptionAsMetaSupport {
  const invoke = useProtectedInvoke();
  const [support, setSupport] = useState<OptionAsMetaSupport>(isTauri() ? 'pending' : 'unknown');
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    invoke<{platform?: unknown} | null>('local_capability').then(capability => {
      if (!alive) return;
      const platform = capability?.platform;
      setSupport(typeof platform !== 'string' ? 'unknown' : platform === 'macos' ? 'supported' : 'unsupported');
    }, () => { if (alive) setSupport('unknown'); });
    return () => { alive = false; };
  }, [invoke]);
  return support;
}
