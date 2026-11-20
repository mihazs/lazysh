const PREFIX = 'LAZYSH-SYNC-V1-';
const key = /LAZYSH-SYNC-V1-[0-9a-f]{1,64}/gi;
const characters = (quote: string) => new RegExp(`\\[\\s*${[...PREFIX].map(char => `${quote}${char}${quote}`).join('\\s*,\\s*')}(?:\\s*,\\s*${quote}[0-9a-f]${quote}){1,64}\\s*\\]`, 'gi');

/** Removes both WebDriver's text and character-array forms of the synthetic recovery key. */
export function redactRecoveryKey(text: string) {
  return text.replace(key, '[redacted sync recovery key]')
    .replace(characters('"'), '[redacted sync recovery key]')
    .replace(characters('&quot;'), '[redacted sync recovery key]');
}
