import {useEffect, useState} from 'react';
import {protectedInvoke} from './access';
import {isHostBrowserConfirmed, onHostBrowserSwitch} from './hostBrowserConfirmation';
import {parseHostBrowserSettings} from './HostBrowserSwitch';

/**
 * Whether the Host browser tool is offered for a session: its host's switch is on and this device confirmed the
 * host. The host is asked only after the confirmation, so a device that never turned the browser on never pays
 * for the read, and a read that fails leaves the answer as it was.
 */
export function useHostBrowserOffered(sessionId: string | undefined, hostKey: string | undefined) {
  const [answer, setAnswer] = useState<{sessionId: string; offered: boolean}>();
  const [read, setRead] = useState(0);
  useEffect(() => onHostBrowserSwitch(() => setRead(count => count + 1)), []);
  useEffect(() => {
    if (!sessionId || !hostKey) return;
    if (!isHostBrowserConfirmed(hostKey)) { setAnswer({sessionId, offered: false}); return; }
    let current = true;
    protectedInvoke('get_host_browser_settings', {sessionId}).then(value => {
      if (current) setAnswer({sessionId, offered: parseHostBrowserSettings(value).hostBrowserEnabled});
    }).catch(() => {});
    return () => { current = false; };
  }, [sessionId, hostKey, read]);
  return !!sessionId && answer?.sessionId === sessionId && answer.offered;
}
