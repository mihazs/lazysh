/** Prompts sent from the Agent view composer, per conversation, oldest first. Page lifetime only: a prompt can hold secrets. */
const sent = new Map<string, string[]>();
const LIMIT = 50;

export function rememberPrompt(key: string, text: string) {
  const list = (sent.get(key) ?? []).filter(item => item !== text);
  sent.set(key, [...list, text].slice(-LIMIT));
}
export const promptsOf = (key: string): readonly string[] => sent.get(key) ?? [];

/** Where Up and Down stand: `index` is the recalled prompt, `null` when the composer holds the person's own text. */
export type Recall = Readonly<{index: number | null; text: string}>;

/** Up and Down walk the history only from an empty composer, or while the text is still exactly the recalled prompt,
 * so editing a recalled prompt or typing something new never loses the edit to a stray arrow key. */
export function recall(history: readonly string[], current: Recall, draft: string, direction: 'up' | 'down'): Recall | undefined {
  const walking = current.index !== null && draft === current.text;
  if (!walking && draft !== '') return;
  if (direction === 'up') {
    if (!history.length) return;
    const index = walking ? Math.max(0, current.index! - 1) : history.length - 1;
    return {index, text: history[index]};
  }
  if (!walking) return;
  const index = current.index! + 1;
  return index >= history.length ? {index: null, text: ''} : {index, text: history[index]};
}
