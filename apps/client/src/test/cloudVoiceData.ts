import type {CloudSnapshot} from '../cloudVoice';
/** Synthetic metadata only; no provider calls, tokens or real account. */
export function cloudSnapshot(): CloudSnapshot {
  return { origin: 'https://voice.example.com', checkedAt: 1792900000000,
    capabilities: {schemaVersion:1, model:'gpt-transcribe', languages:['auto','pt'],maxWavBytes:960044,sampleRate:16000,maxSamples:480000},
    quota: {windowStart:1792800000,windowEnd:1792886400,deviceLimitSamples:480000,deviceUsedSamples:0,deviceRemainingSamples:480000,
      globalLimitSamples:960000,globalUsedSamples:0,globalRemainingSamples:960000} };
}
