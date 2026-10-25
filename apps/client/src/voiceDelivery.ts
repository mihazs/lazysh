export type DirectDictation = {
  sessionId: string;
  text: string;
  autoSend: boolean;
  // Consume the recording generation immediately before dispatch; a failed write is not retried.
  claim: () => boolean;
};

export function dictationInput(text: string, autoSend: boolean): string {
  if (typeof text !== 'string' || !text.trim())
    throw new Error('No text to type. Your draft is unchanged.');
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text))
    throw new Error('Direct dictation requires one line without control characters. Edit or stage the draft instead.');
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new Error('Direct dictation contains invalid Unicode. Edit the draft instead.');
  }
  const data = autoSend ? `${text}\r` : text;
  if (new TextEncoder().encode(data).byteLength > 65536)
    throw new Error('Direct dictation exceeds 64 KiB including Enter. Shorten or stage the draft instead.');
  return data;
}
