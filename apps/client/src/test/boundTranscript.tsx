import {invoke} from '@tauri-apps/api/core';
import {act,render} from '@testing-library/react';
import {vi} from 'vitest';
import ChatPanel,{type BoundConversation} from '../ChatPanel';
import {chatFollowAccess} from './chatFollowAccess';

/** Answers a bound panel's transcript reads with `reply()` and gives it no watch channel, so it polls: fake timers, a visible page, Follow allowed. */
export function answerTranscripts(reply: () => unknown) {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  chatFollowAccess();
  Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'agent_transcript') return reply();
    if (command === 'agent_watch_start') throw new Error('no channel');
    if (command === 'agent_watch_stop') return;
    throw new Error(`Unexpected ${command}`);
  });
}

/** The Agent view's panel for `bound`, after its first transcript read. */
export async function openBound(bound: BoundConversation) {
  render(<ChatPanel sessionId="host" shown bound={bound} timeline />);
  await act(async () => {await vi.advanceTimersByTimeAsync(0);});
}
