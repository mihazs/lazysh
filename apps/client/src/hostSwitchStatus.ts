import {useState} from 'react';
import type {UiErrorCause} from './i18n/localError';

/** The status every separately saved host switch form keeps: an outdated companion, a failure, a request in flight, a save done. */
export function useHostSwitchStatus() {
  const [outdatedCompanion,setOutdatedCompanion]=useState(false);
  const [error,setError]=useState<UiErrorCause | {refresh:UiErrorCause}>('');
  const [busy,setBusy]=useState(false);
  const [saved,setSaved]=useState(false);
  return {outdatedCompanion,setOutdatedCompanion,error,setError,busy,setBusy,saved,setSaved};
}
