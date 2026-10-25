// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { boundDictationHistory, useDictationHistory, VOICE_HISTORY_AGE, VOICE_HISTORY_BYTES } from './voiceHistory';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
const entry=(text='dictation',createdAt=Date.now())=>({id:crypto.randomUUID(),text,createdAt});
it('retains temporary current-view results without requiring persistent storage',async()=>{
  const first=renderHook(()=>useDictationHistory());
  await act(async()=>{await first.result.current.add('private prompt',first.result.current.capture());});
  expect(first.result.current.entries[0].text).toBe('private prompt');
  first.unmount();
  const second=renderHook(()=>useDictationHistory());
  expect(second.result.current.remember).toBe(false);expect(second.result.current.entries).toEqual([]);
});
it('bounds count and serialized UTF-8 size without truncating a retained prompt',()=>{
  const entries=Array.from({length:30},(_,index)=>entry(`prompt ${index}`));
  expect(boundDictationHistory(entries,false)).toEqual(entries.slice(0,20));
  const large=Array.from({length:20},()=>entry('語'.repeat(65536)));
  const bounded=boundDictationHistory(large,false);
  expect(bounded).toHaveLength(1);expect(bounded[0].text).toHaveLength(65536);
  expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThan(VOICE_HISTORY_BYTES);
});
it('expires persistent entries from original recording time and rejects future entries',()=>{
  const now=Date.now(),recent=entry('recent',now-VOICE_HISTORY_AGE+1000);
  expect(boundDictationHistory([recent,entry('expired',now-VOICE_HISTORY_AGE),entry('future',now+6000)],true,now)).toEqual([recent]);
});
it('clear, delete, retention changes and unmount invalidate pending captures',async()=>{
  for(const change of ['clear','remove','disable','cancel','unmount'] as const){
    const history=renderHook(()=>useDictationHistory());
    await act(async()=>{await history.result.current.add('old text',history.result.current.capture());});
    const captured=history.result.current.capture(),id=history.result.current.entries[0].id;
    await act(async()=>{
      if(change==='cancel')history.result.current.invalidate();
      else if(change==='unmount')history.unmount();
      else if(change==='clear')await history.result.current.clear();
      else if(change==='remove')await history.result.current.remove(id);
      else await history.result.current.setRemember(false);
    });
    await act(async()=>{await history.result.current.add('late private text',captured);});
    expect(history.result.current.entries.some(entry=>entry.text==='late private text')).toBe(false);
    history.unmount();
  }
});
it('does not enable persistence when IndexedDB is unavailable',async()=>{
  const history=renderHook(()=>useDictationHistory());
  await waitFor(()=>expect(history.result.current.ready).toBe(true));
  await act(async()=>{await history.result.current.setRemember(true);});
  expect(history.result.current.remember).toBe(false);expect(history.result.current.error).toContain('Could not enable');
  await act(async()=>{await history.result.current.add('current-view only',history.result.current.capture());});
  expect(history.result.current.entries[0].text).toBe('current-view only');
});
it('rejects unsafe text without echoing its contents in the error',async()=>{
  const history=renderHook(()=>useDictationHistory());
  await act(async()=>{await history.result.current.add('private\u001bcommand',history.result.current.capture());});
  expect(history.result.current.entries).toEqual([]);expect(history.result.current.error).not.toContain('private');
});

it('keeps the recording capture timestamp rather than refreshing it after inference',async()=>{
  const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now);
  const history=renderHook(()=>useDictationHistory());
  const captured=history.result.current.capture();clock.mockReturnValue(now+120000);
  await act(async()=>{await history.result.current.add('slow inference result',captured);});
  expect(history.result.current.entries[0].createdAt).toBe(now);
});
