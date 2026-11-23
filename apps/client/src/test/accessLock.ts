import {acknowledgeAccessReady, accessSnapshot, applyAccessStatus} from '../access';

let generation = 0;
/** The app's access state as the native lock reports it; an unlock is acknowledged the way the shell does. Answers the nonce of an unlock. */
export function setLocked(locked: boolean) {
  const nonce = String(++generation).padStart(64, 'a');
  applyAccessStatus({initialized: true, supported: true, reason: '', enabled: true, locked, generation: String(generation), ...(locked ? {} : {nonce})});
  if (!locked) acknowledgeAccessReady(accessSnapshot().epoch);
  return nonce;
}
