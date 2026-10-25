import { vi } from 'vitest';
/** Shared silent recorder; individual tests control inference and decoding. */
export function installSpeechCapture(decode?: Promise<unknown>) {
  const captures: Capture[] = [];
  class Capture {
    constructor() { captures.push(this); }
    onerror: (() => void) | undefined;
    ondataavailable: ((event: {data: Blob}) => void) | undefined;
    state = 'inactive'; mimeType = 'audio/webm'; onstop: (() => void) | undefined;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Capture);
  vi.stubGlobal('Blob', class { async arrayBuffer() { return new ArrayBuffer(0); } });
  const audio = {sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(1600)};
  vi.stubGlobal('AudioContext', class {
    async decodeAudioData() { return decode ? await decode : audio; }
    async close() {}
  });
  const stop = vi.fn();
  const microphone = vi.fn().mockResolvedValue({getTracks: () => [{stop}]});
  Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: microphone}});
  return {captures, audio, stop, microphone};
}
