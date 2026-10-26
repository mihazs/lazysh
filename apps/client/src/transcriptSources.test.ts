import {expect, it} from 'vitest';
import {isDiscoveredTranscript, transcriptAgents, usageAgents} from './transcriptSources';

it('retains distinct transcript and usage identity limits in shared discovery validation', () => {
  const source = {path:'/host/transcript', name:'Recorded session', sessionId:'s'.repeat(257)};
  expect(isDiscoveredTranscript(source, 256)).toBe(false);
  expect(isDiscoveredTranscript(source, 4096)).toBe(true);
  expect(isDiscoveredTranscript({...source,sessionId:'s'.repeat(4097)},4096)).toBe(false);
  for (const invalid of [null, {path:2,name:'session'}, {path:'/',name:[]}, {path:'x'.repeat(4097),name:'session'}, {path:'/',name:'n'.repeat(4097)}, {path:'/',name:'session',sessionId:null}]) {
    expect(isDiscoveredTranscript(invalid,4096)).toBe(false);
  }
  expect(isDiscoveredTranscript({path:'/',name:'session'},256)).toBe(true);
});
it('keeps record-only agents out of recorded usage selection even when discovery is available', () => {
  for (const agent of ['grok-acp','antigravity-jsonl']) {
    expect(Object.hasOwn(transcriptAgents,agent)).toBe(true);
    expect(Object.hasOwn(usageAgents,agent)).toBe(false);
  }
});
