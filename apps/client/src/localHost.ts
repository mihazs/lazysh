import {t} from './i18n/core';

/** A local target's stable host key: its sessions share one Agents board, archive and inbox host, as the tabs of a saved host do. */
export const localHostKey=(target='default')=>`local:${target}`;
export const localHostLabel=()=>t('localThisDevice');
