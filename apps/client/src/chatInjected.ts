/** Agent harnesses write some "user" records themselves: background-task notices, slash-command echoes, local command output,
 * interruption markers, compaction summaries and context wrappers. The person did not type them, so a conversation view must
 * not show their tags as a chat bubble. This runs in the client so it also works against an older host companion. */
export const recordedEventKinds = ['goal', 'goalMet', 'planMode', 'planModeExit', 'recap', 'hookFailed'] as const;
export type InjectedEvent = {kind: 'task' | 'output' | 'interrupted' | 'compacted' | 'answer' | typeof recordedEventKinds[number]; text: string; detail?: string};
type Block = {type: string; text?: string; card?: unknown; pasted?: boolean};
type Shape = {role: string; blocks: Block[]};

/** Context the harness adds for the model. It is never shown. */
const hiddenTags = new Set(['system-reminder', 'local-command-caveat', 'environment_context', 'codex_internal_context', 'user_instructions', 'skill', 'recommended_plugins', 'turn_aborted']);
const entities: Record<string, string> = {'&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&'};
const inner = (text: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim();
const plain = (text: string) => text.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|quot|amp|#39);/g, entity => entities[entity]).trim();

/** Claude Code wraps pasted text as `<pasted_content id="05cc">…</pasted_content id="05cc">` (the closing tag carries the id too).
 * The words typed around it stay text blocks; each paste becomes its own block, marked `pasted`. An unclosed one runs to the end. */
const pastedContent = /<pasted_content(?:\s[^>]*)?>([\s\S]*?)(?:<\/pasted_content(?:\s[^>]*)?>|$)/g;
function splitPasted<B extends Block>(block: B): B[] {
  const text = block.text ?? '';
  const parts: B[] = [];
  let from = 0;
  const add = (part: string, pasted?: true) => { if (part.trim()) parts.push({...block, text: part.trim(), ...(pasted && {pasted})}); };
  for (const match of text.matchAll(pastedContent)) {
    add(text.slice(from, match.index));
    add(match[1], true);
    from = match.index + match[0].length;
  }
  if (!from) return [block];
  add(text.slice(from));
  return parts;
}

type Verdict = {hide: true} | {text: string} | {event: InjectedEvent};
function classify(source: string): Verdict {
  // A reminder can ride inside any record, including a notification; it is context, not content.
  const text = source.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || /^# AGENTS\.md instructions for /.test(text) || /^\[Image: original \d+x\d+/.test(text)) return {hide: true};
  const tag = /^<([a-zA-Z][\w-]*)[\s>]/.exec(text)?.[1];
  if (tag && hiddenTags.has(tag)) return {hide: true};
  switch (tag) {
    case 'task-notification': {
      const [summary, event, status, result] = ['summary', 'event', 'status', 'result'].map(name => inner(text, name));
      return {event: {kind: 'task', text: event ?? summary ?? '', detail: [event && summary, status && `${status}`, result].filter(Boolean).join('\n') || undefined}};
    }
    case 'command-name': case 'command-message': case 'command-args': {
      const name = inner(text, 'command-name') ?? `/${inner(text, 'command-message') ?? ''}`;
      return {text: [name, inner(text, 'command-args')].filter(Boolean).join(' ')};
    }
    case 'bash-input': return {text: `! ${plain(text)}`};
    case 'bash-stdout': case 'bash-stderr': case 'local-command-stdout': case 'local-command-stderr': {
      const output = plain(text);
      const [first, ...rest] = output.split('\n');
      return output ? {event: {kind: 'output', text: first, detail: rest.length ? output : undefined}} : {hide: true};
    }
    case 'send_user_message_question_reply': {
      let answers = '';
      try { answers = (JSON.parse(plain(text)) as {answer?: unknown}[]).map(item => item.answer).filter((answer): answer is string => typeof answer === 'string').join(' · '); } catch { /* The raw reply stays in the details. */ }
      return {event: {kind: 'answer', text: answers}};
    }
  }
  if (text.startsWith('[Request interrupted')) return {event: {kind: 'interrupted', text: ''}};
  if (text.startsWith('This session is being continued from a previous conversation')) return {event: {kind: 'compacted', text: '', detail: text}};
  return {text};
}

/** User records shown as people wrote them, as one compact event, or dropped; redacted (empty) thinking is dropped too.
 * Anything else passes through untouched. */
export function projectMessages<M extends Shape>(messages: M[]): (M & {event?: InjectedEvent})[] {
  return messages.flatMap(message => {
    if (message.role === 'assistant') {
      const blocks = message.blocks.filter(block => block.type !== 'thinking' || block.text?.trim());
      return blocks.length ? [blocks.length === message.blocks.length ? message : {...message, blocks}] : [];
    }
    if (message.role !== 'user') return [message];
    let event: InjectedEvent | undefined, kept = false;
    const blocks = message.blocks.flatMap(block => {
      if (block.type !== 'text' || block.card !== undefined || block.text === undefined) {kept ||= block.type !== 'text' || block.card !== undefined; return [block];}
      const verdict = classify(block.text);
      if ('hide' in verdict) return [];
      if ('event' in verdict) {event ??= verdict.event; return [block];}
      kept = true;
      return splitPasted({...block, text: verdict.text});
    });
    if (!blocks.length) return [];
    // An event record carries nothing else; a mixed record keeps its words and drops no information.
    return event && !kept ? [{...message, event}] : [{...message, blocks}];
  });
}
