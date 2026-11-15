import {t} from './i18n/core';

/** A local target's stable host key: its sessions share one Agents board, archive and inbox host, as the tabs of a saved host do. */
export const localHostKey=(target='default')=>`local:${target}`;
export const localHostLabel=()=>t('localThisDevice');

/** Which executable a local target resolved for the companion, as `local_capability` reports it. */
export type CompanionSource='bundled'|'managed'|'path';
export const companionSourceLabels={bundled:'companionSourceBundled',managed:'companionSourceManaged',path:'companionSourcePath'} as const;
const sources=Object.keys(companionSourceLabels);
export const companionSourceOf=(value:unknown):CompanionSource|undefined=>typeof value==='string'&&sources.includes(value)?value as CompanionSource:undefined;
