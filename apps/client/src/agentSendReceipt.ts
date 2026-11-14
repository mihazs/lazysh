/** What the guarded input said about a send: still waiting, accepted into the terminal, refused before anything was
 * written, or failed after writing began (delivery unknown). */
export type SendPhase = 'pending' | 'accepted' | 'refused' | 'unknown';
export type ReceiptState = 'sending' | 'sent' | 'queued' | 'unconfirmed' | 'notSent' | 'uncertain';

/** How long an accepted message may take to appear in the conversation before the receipt stops saying "Sending". */
export const echoWindowMs = 8000;
const normal = (text: string) => text.replace(/\s+/g, ' ').trim();
const count = (list: readonly string[], text: string) => list.filter(item => normal(item) === normal(text)).length;

/** The receipt of one message. The transcript settles it: `before` is how many identical prompts the conversation already
 * held when the message was sent, so an older identical prompt never counts as its echo. Retry is offered for `notSent` only. */
export function receiptState({phase, text, before, prompts, queued, elapsedMs}: {
  phase: SendPhase; text: string; before: number; prompts: readonly string[]; queued: readonly string[]; elapsedMs: number;
}): ReceiptState {
  if (phase === 'pending') return 'sending';
  if (phase === 'refused') return 'notSent';
  if (phase === 'unknown') return 'uncertain';
  if (count(prompts, text) > before) return 'sent';
  if (count(queued, text) > 0) return 'queued';
  return elapsedMs < echoWindowMs ? 'sending' : 'unconfirmed';
}
export const promptsLike = count;
export const canRetry = (state: ReceiptState) => state === 'notSent';
