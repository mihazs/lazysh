import {LocalUiError} from './i18n/localError';

type Receipt = {source: string; offset: number; length: number; prefix: string};
export function recordedReceipt(token: unknown): Receipt {
  const match = typeof token === 'string' && token.length <= 150
    ? /^g1:([0-9a-f]{64}):(0|[1-9][0-9]{0,7}):(0|[1-9][0-9]{0,7}):([0-9a-f]{64})$/.exec(token)
    : null;
  if (!match || match[0] !== token) throw new LocalUiError('chatRecordedUnsupported');
  const offset = Number(match[2]), length = Number(match[3]);
  if (offset > length || length > 16 * 1024 * 1024) throw new LocalUiError('chatRecordedUnsupported');
  return {source:match[1],offset,length,prefix:match[4]};
}

export function validateRecordedPage(
  page: {agent: string; view?: string; checkpoint?: string; nextOffset: number; messages: unknown[]; hasMore: boolean},
  offset: number,
  previous?: string,
) {
  const next = recordedReceipt(page.checkpoint);
  if (page.agent !== 'grok-acp' || page.view !== 'record_stream' || next.offset !== page.nextOffset)
    throw new LocalUiError('chatRecordedUnsupported');
  if (page.nextOffset < offset || ((page.messages.length > 0 || page.hasMore) && page.nextOffset === offset))
    throw new LocalUiError('chatRecordedChanged');
  if (previous !== undefined) {
    const old = recordedReceipt(previous);
    if (old.offset !== offset || old.source !== next.source || next.length < old.length
      || (next.length === old.length && next.prefix !== old.prefix))
      throw new LocalUiError('chatRecordedChanged');
  }
  // The native raw reader keys each displayed record by its physical byte start.
  // Cursor progress alone must never let a replayed ID overwrite verified text.
  let last = offset - 1;
  for (const message of page.messages) {
    const id = message && typeof message === 'object' && 'id' in message ? message.id : undefined;
    const match = typeof id === 'string' ? /^grok-record-(0|[1-9][0-9]{0,7})$/.exec(id) : null;
    const physical = match ? Number(match[1]) : NaN;
    if (!match || match[0] !== id || physical < offset || physical >= page.nextOffset || physical <= last)
      throw new LocalUiError('chatRecordedChanged');
    last = physical;
  }
}
