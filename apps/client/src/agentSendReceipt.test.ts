import {expect,it} from 'vitest';
import {canRetry,echoWindowMs,promptsLike,receiptState} from './agentSendReceipt';

const base = {text: 'Add a test', before: 0, prompts: [] as string[], queued: [] as string[], elapsedMs: 100};

it('says Sending until the terminal accepted the input, then until the conversation shows the message',()=>{
  expect(receiptState({...base, phase: 'pending'})).toBe('sending');
  expect(receiptState({...base, phase: 'accepted'})).toBe('sending');
  expect(receiptState({...base, phase: 'accepted', prompts: ['Add  a\ntest']})).toBe('sent');
});

it('does not take an older identical prompt for the echo',()=>{
  const older = ['Add a test'];
  expect(promptsLike(older, 'add a test')).toBe(0);
  expect(receiptState({...base, phase: 'accepted', before: 1, prompts: older})).toBe('sending');
  expect(receiptState({...base, phase: 'accepted', before: 1, prompts: [...older, 'Add a test']})).toBe('sent');
});

it('shows a message the agent holds back as queued, and stops claiming progress after the echo window',()=>{
  expect(receiptState({...base, phase: 'accepted', queued: ['Add a test']})).toBe('queued');
  expect(receiptState({...base, phase: 'accepted', elapsedMs: echoWindowMs})).toBe('unconfirmed');
});

it('offers Retry only when nothing was delivered',()=>{
  const states = (['refused', 'unknown', 'accepted'] as const).map(phase => receiptState({...base, phase, elapsedMs: echoWindowMs}));
  expect(states).toEqual(['notSent', 'uncertain', 'unconfirmed']);
  expect(states.map(canRetry)).toEqual([true, false, false]);
});
