export const MAX_VOICE_SECONDS = 30;

export function mono16k(channels: Float32Array[], sampleRate: number): number[] {
  if (!channels.length || channels.length > 8 || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || channels.some(channel => channel.length !== channels[0].length) || channels[0].length > sampleRate * MAX_VOICE_SECONDS) throw new Error('Choose audio up to 30 seconds.');
  const count = Math.floor(channels[0].length * 16000 / sampleRate);
  if (count < 1600) throw new Error('Record at least 0.1 seconds of speech.');
  const samples = new Array<number>(count);
  for (let index = 0; index < count; index++) {
    const start = Math.floor(index * sampleRate / 16000);
    const end = Math.min(channels[0].length, Math.max(start + 1, Math.floor((index + 1) * sampleRate / 16000)));
    let sum = 0;
    for (const channel of channels) for (let cursor = start; cursor < end; cursor++) { if (!Number.isFinite(channel[cursor])) throw new Error('Invalid audio sample.'); sum += channel[cursor]; }
    samples[index] = Math.max(-1, Math.min(1, sum / ((end - start) * channels.length)));
  }
  return samples;
}

export function validModelFile(file: { name: string; size: number }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\.bin$/.test(file.name) || file.size < 1024 || file.size > 160 * 1024 * 1024) throw new Error('Choose a trusted Whisper tiny/base GGML .bin model up to 160 MiB.');
}
