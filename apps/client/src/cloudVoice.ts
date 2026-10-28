import {LocalUiError} from './i18n/localError';
export const CLOUD_LANGUAGES: Record<string, string> = {
  auto: 'Detect language', en: 'English', es: 'Español', fr: 'Français',
  de: 'Deutsch', pt: 'Português', ja: '日本語', zh: '中文',
};
export type CloudQuota = {
  windowStart: number; windowEnd: number;
  deviceLimitSamples: number; deviceUsedSamples: number; deviceRemainingSamples: number;
  globalLimitSamples: number; globalUsedSamples: number; globalRemainingSamples: number;
};
export type CloudSnapshot = {
  origin: string; checkedAt: number;
  capabilities: { schemaVersion: 1; model: 'gpt-transcribe' | 'whisper.cpp'; languages: string[]; maxWavBytes: 960044; sampleRate: 16000; maxSamples: 480000 };
  quota: CloudQuota;
};
export function validCloudOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === '/' && origin === url.origin;
  } catch { return false; }
}
export function validateCloudQuota(value: CloudQuota): CloudQuota {
  if (!value || ['windowStart', 'windowEnd', 'deviceLimitSamples', 'deviceUsedSamples', 'deviceRemainingSamples',
    'globalLimitSamples', 'globalUsedSamples', 'globalRemainingSamples'].some(key => {
      const number = value[key as keyof CloudQuota];
      return !Number.isSafeInteger(number) || number < 0;
    }) || value.windowStart > 8_640_000_000_000 || value.windowEnd > 8_640_000_000_000 || value.windowEnd <= value.windowStart
    || value.deviceRemainingSamples !== Math.max(0, value.deviceLimitSamples - value.deviceUsedSamples)
    || value.globalRemainingSamples !== Math.max(0, value.globalLimitSamples - value.globalUsedSamples))
    throw new LocalUiError('cloudInvalidQuota');
  return value;
}
export function validateCloudSnapshot(value: CloudSnapshot): CloudSnapshot {
  const caps = value?.capabilities;
  if (!value || !validCloudOrigin(value.origin) || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0
    || !caps || caps.schemaVersion !== 1 || !['gpt-transcribe','whisper.cpp'].includes(caps.model) || caps.sampleRate !== 16000
    || caps.maxSamples !== 480000 || caps.maxWavBytes !== 960044 || !Array.isArray(caps.languages)
    || caps.languages.length < 1 || caps.languages.length > 8 || new Set(caps.languages).size !== caps.languages.length
    || caps.languages.some(code => typeof code !== 'string' || !Object.hasOwn(CLOUD_LANGUAGES, code)))
    throw new LocalUiError('cloudInvalidCapabilities');
  validateCloudQuota(value.quota);
  return value;
}
