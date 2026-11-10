import {useEffect, useRef, useState} from 'react';
import {useProtectedInvoke} from './access';
import {t} from './i18n/core';

type StreamSettings = {schemaVersion: 1; revision: number; enabled: boolean};
function parse(value: unknown): StreamSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid stream settings');
  const row = value as StreamSettings;
  if (Object.keys(row).sort().join(',') !== 'enabled,revision,schemaVersion' || row.schemaVersion !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.enabled !== 'boolean') throw new Error('Invalid stream settings');
  return row;
}
export default function CompanionStreamSettings({sessionId, visible}: {sessionId: string; visible: boolean}) {
  const invoke = useProtectedInvoke();
  const [settings, setSettings] = useState<StreamSettings>();
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!visible) return;
    const current = ++generation.current;
    setBusy(true); setUnavailable(false);
    void invoke('companion_stream_settings', {sessionId}).then(value => {
      const result = parse(value); if (current === generation.current) setSettings(result);
    }).catch(() => {if (current === generation.current) {setSettings(undefined); setUnavailable(true);}}).finally(() => {if (current === generation.current) setBusy(false);});
    return () => {generation.current++;};
  }, [sessionId, visible, invoke]);
  async function update(enabled: boolean) {
    if (!settings || busy || !visible) return;
    const current = ++generation.current;
    setBusy(true); setUnavailable(false);
    try {const result = parse(await invoke('companion_stream_settings', {sessionId, expectedRevision: settings.revision, enabled})); if (current === generation.current) setSettings(result);}
    catch {if (current === generation.current) {setSettings(undefined); setUnavailable(true);}}
    finally {if (current === generation.current) setBusy(false);}
  }
  return <div>
    {settings && <label><input type="checkbox" checked={settings.enabled} disabled={busy || !visible} onChange={event => void update(event.target.checked)}/>{t('companionStreaming')}</label>}
    <p>{t('companionStreamingHint')}</p>
    {unavailable && <p role="status">{t('companionStreamingUnavailable')}</p>}
  </div>;
}
