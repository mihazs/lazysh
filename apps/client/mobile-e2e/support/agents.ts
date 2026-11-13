import {browser} from '@wdio/globals';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {agentsFixture} from '../../../../tests/support/androidHerdr';
import {readEndpoint} from './hosts';

// The `herdr-agents` host: a Codex agent whose pane records every byte it is sent, a second Codex agent that waits for an answer,
// a Claude agent, a tab with no agent, and a recorded account report. The names of its tabs and sessions are the fixture's.
export {agentsFixture};
export type Receiver = 'receiver' | 'blockedReceiver';

/** What the pane of the agent has received so far, byte for byte. */
async function received(receiver: Receiver) {
  const {home} = await readEndpoint('herdr-agents');
  return readFile(join(home, agentsFixture[receiver], 'received-bytes'), 'utf8').catch(() => '');
}
/** Waits until the agent has received exactly `expected`: a repeat or a stray byte fails it as surely as a missing one. */
export const waitForReceived = (receiver: Receiver, expected: string) =>
  browser.waitUntil(async () => (await received(receiver)) === expected, {timeout: 20_000, timeoutMsg: `The ${receiver} pane did not receive exactly ${JSON.stringify(expected)}`});
export const receivedNothing = async (receiver: Receiver) => (await received(receiver)) === '';
