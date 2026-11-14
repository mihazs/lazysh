import {LocalUiError} from './i18n/localError';

export type HostFeatures = {schemaVersion: 1; revision: number; simulatorStreamingEnabled: boolean; portScanEnabled: boolean};
const fields = ['schemaVersion', 'revision', 'simulatorStreamingEnabled', 'portScanEnabled'];
/** The host's `host-features.json` as the native layer returns it; anything it does not exactly describe is refused. */
export function parseHostFeatures(value: unknown): HostFeatures {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalUiError('companionUnsupported');
  const features = value as HostFeatures;
  if (Object.keys(features).some(key => !fields.includes(key)) || features.schemaVersion !== 1 || !Number.isSafeInteger(features.revision) || features.revision < 0 || [features.simulatorStreamingEnabled, features.portScanEnabled].some(flag => typeof flag !== 'boolean')) throw new LocalUiError('companionUnsupported');
  return features;
}
/** `null` or an absent value means the host's companion has no feature switches: every switch counts as enabled. */
export function parseOptionalHostFeatures(value: unknown): HostFeatures | null {
  return value === null || value === undefined ? null : parseHostFeatures(value);
}
