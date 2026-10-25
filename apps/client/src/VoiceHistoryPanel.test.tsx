// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import VoiceHistoryPanel from './VoiceHistoryPanel';
import { useDictationHistory } from './voiceHistory';

afterEach(cleanup);
it('explains opt-in plaintext storage and pruning on use rather than closed-app deletion',()=>{
  const hook=renderHook(()=>useDictationHistory());
  render(<VoiceHistoryPanel history={hook.result.current} onReuse={()=>{}}/>);
  expect(screen.getByLabelText('Remember dictation history on this device')).toHaveProperty('checked',false);
  expect(screen.getByText(/not encrypted by lazysh/)).toBeTruthy();
  expect(screen.getByText(/not while the app is closed/)).toBeTruthy();
});
it('restores complete text to the editable draft only on an explicit reusable-result action',async()=>{
  const hook=renderHook(()=>useDictationHistory());
  await act(async()=>{await hook.result.current.add('correct this prompt',hook.result.current.capture());});
  const reuse=vi.fn();
  const {rerender}=render(<VoiceHistoryPanel history={hook.result.current} onReuse={reuse}/>);
  fireEvent.click(screen.getByRole('button',{name:'Reuse dictation 1'}));expect(reuse).toHaveBeenCalledWith('correct this prompt');
  rerender(<VoiceHistoryPanel history={hook.result.current} onReuse={reuse} disabled/>);
  expect(screen.getByRole('button',{name:'Reuse dictation 1'})).toHaveProperty('disabled',true);
  fireEvent.click(screen.getByRole('button',{name:'Reuse dictation 1'}));expect(reuse).toHaveBeenCalledOnce();
});
