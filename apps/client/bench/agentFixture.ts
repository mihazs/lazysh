// Deterministic synthetic Claude Code transcript for the Agent view load benchmarks (docs/reference/agent-view-performance.md).
// Only the record TYPES, key sets and size distributions of real sessions are copied; every word is generated from a seeded
// PRNG, so the fixture holds no private content and is byte-identical for one seed.
import {writeFileSync} from 'node:fs';

export type FixtureOptions = {seed?: number; turns?: number; /** Share of tool results that are very large (log dumps, file reads). */heavy?: number; images?: number; sessionId?: string};
export type Fixture = {jsonl: string; records: number; bytes: number; conversationRecords: number};

function random(seed: number) {
  let state = seed >>> 0;
  return () => {state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296;};
}
const WORDS = 'agent build cache client commit config deploy diff event fetch handle index input list merge module native output parse queue render route search session stream test token update value view watch window'.split(' ');
const LANGS = ['ts', 'rust', 'json', 'sh', 'diff', 'tsx'];

export function generateClaudeTranscript({seed = 1, turns = 600, heavy = 0.04, images = 3, sessionId = '00000000-0000-4000-8000-000000000001'}: FixtureOptions = {}): Fixture {
  const rand = random(seed), pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)], between = (low: number, high: number) => low + Math.floor(rand() * (high - low + 1));
  const words = (count: number) => Array.from({length: count}, () => pick(WORDS)).join(' ');
  const sentence = () => `${words(between(5, 14))}.`;
  const code = (lines: number, lang: string) => Array.from({length: lines}, (_, i) => lang === 'sh' ? `$ ${pick(WORDS)} --${pick(WORDS)} ${i}` : lang === 'json' ? `  "${pick(WORDS)}${i}": ${between(0, 9999)},` : `  const ${pick(WORDS)}${i} = ${pick(WORDS)}(${between(0, 99)}, '${pick(WORDS)}'); // ${words(3)}`).join('\n');
  const markdown = (size: number) => {
    const parts: string[] = [];
    while (parts.join('\n\n').length < size) {
      const kind = rand();
      parts.push(kind < 0.45 ? sentence() + ' ' + sentence() : kind < 0.6 ? `## ${words(3)}\n\n${sentence()}` : kind < 0.75 ? Array.from({length: between(3, 7)}, () => `- **${pick(WORDS)}**: ${words(6)}`).join('\n')
        : kind < 0.85 ? `| ${pick(WORDS)} | ${pick(WORDS)} | ${pick(WORDS)} |\n| --- | --- | --- |\n${Array.from({length: between(2, 6)}, () => `| ${words(2)} | ${between(1, 999)} | ${words(1)} |`).join('\n')}`
        : `\`\`\`${pick(LANGS)}\n${code(between(4, 40), pick(LANGS))}\n\`\`\``);
    }
    return parts.join('\n\n');
  };
  const rows: string[] = [];
  let conversation = 0, clock = Date.parse('2026-01-01T00:00:00Z'), parent: string | null = null, counter = 0;
  const id = () => `${(++counter).toString(16).padStart(8, '0')}-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
  const stamp = () => new Date(clock += between(300, 40000)).toISOString();
  const base = (type: string, uuid: string) => ({parentUuid: parent, isSidechain: false, type, uuid, timestamp: stamp(), userType: 'external', entrypoint: 'cli', cwd: '/work/project', sessionId, version: '2.1.0', gitBranch: 'main'});
  const push = (record: Record<string, unknown>) => {rows.push(JSON.stringify(record)); if (record.uuid) {conversation++; parent = record.uuid as string;}};
  const noise = () => {
    const t = rand();
    if (t < 0.25) rows.push(JSON.stringify({type: 'queue-operation', operation: pick(['enqueue', 'dequeue', 'remove']), timestamp: stamp(), sessionId, content: words(4)}));
    else if (t < 0.4) rows.push(JSON.stringify({type: 'permission-mode', permissionMode: 'default', sessionId}));
    else if (t < 0.5) rows.push(JSON.stringify({type: 'file-history-snapshot', messageId: id(), snapshot: {messageId: id(), trackedFileBackups: {}, timestamp: stamp()}, isSnapshotUpdate: false}));
    else if (t < 0.6) rows.push(JSON.stringify({type: 'last-prompt', lastPrompt: words(6), sessionId}));
    else if (t < 0.7) push({...base('attachment', id()), attachment: {type: 'hook_success', content: markdown(300), hookName: 'PostToolUse'}});
    else if (t < 0.8) push({...base('system', id()), subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [], hookErrors: [], isMeta: false, level: 'suggestion'});
  };
  let imagesLeft = images;
  for (let turn = 0; turn < turns; turn++) {
    noise();
    const content: unknown[] = [{type: 'text', text: rand() < 0.15 ? markdown(between(800, 4000)) : words(between(4, 30))}];
    if (imagesLeft > 0 && rand() < 0.02) {imagesLeft--; content.push({type: 'image', source: {type: 'base64', media_type: 'image/png', data: Buffer.from(Array.from({length: between(40000, 120000)}, () => between(0, 255))).toString('base64')}});}
    push({...base('user', id()), promptId: id(), message: {role: 'user', content}, permissionMode: 'default'});
    const steps = between(0, 9);
    for (let step = 0; step < steps; step++) {
      const toolId = `toolu_${seed}_${turn}_${step}`, tool = pick(['Bash', 'Bash', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Agent', 'TodoWrite']);
      const large = rand() < heavy, lang = pick(LANGS);
      const input = tool === 'Bash' ? {command: `${pick(WORDS)} --${pick(WORDS)} ${words(3)}`, description: words(4)}
        : tool === 'Read' ? {file_path: `/work/project/src/${pick(WORDS)}.${lang}`} : tool === 'Edit' ? {file_path: `/work/project/src/${pick(WORDS)}.ts`, old_string: code(between(2, 12), 'ts'), new_string: code(between(2, 14), 'ts')}
        : tool === 'Write' ? {file_path: `/work/project/${pick(WORDS)}.md`, content: markdown(between(500, 6000))} : tool === 'Grep' ? {pattern: pick(WORDS), path: '/work/project'}
        : tool === 'Agent' ? {description: words(3), prompt: markdown(600), subagent_type: 'general-purpose'} : {todos: Array.from({length: between(2, 7)}, () => ({content: words(5), status: pick(['pending', 'in_progress', 'completed']), activeForm: words(4)}))};
      push({...base('assistant', id()), message: {id: `msg_${turn}_${step}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4', content: [...(rand() < 0.3 ? [{type: 'thinking', thinking: words(between(10, 60)), signature: 'x'.repeat(40)}] : []), ...(rand() < 0.5 ? [{type: 'text', text: sentence()}] : []), {type: 'tool_use', id: toolId, name: tool, input}], stop_reason: 'tool_use', usage: {input_tokens: between(10, 9000), output_tokens: between(10, 900), cache_read_input_tokens: between(0, 90000), cache_creation_input_tokens: between(0, 9000)}}, requestId: `req_${turn}_${step}`});
      const output = tool === 'Edit' ? 'The file has been updated.' : tool === 'TodoWrite' ? 'Todos have been modified successfully.' : large ? code(between(1500, 2600), tool === 'Read' ? lang : 'sh') : tool === 'Read' ? code(between(3, 400), lang) : code(between(1, 60), 'sh');
      const patch = tool === 'Edit' ? {structuredPatch: [{oldStart: 1, oldLines: between(2, 12), newStart: 1, newLines: between(2, 14), lines: [...(input as {old_string: string}).old_string.split('\n').map(line => `-${line}`), ...(input as {new_string: string}).new_string.split('\n').map(line => `+${line}`)]}]} : undefined;
      noise();
      push({...base('user', id()), message: {role: 'user', content: [{type: 'tool_result', tool_use_id: toolId, content: output, ...(rand() < 0.05 ? {is_error: true} : {})}]}, toolUseResult: patch ?? {stdout: output.slice(0, 2000), stderr: '', interrupted: false}, sourceToolAssistantUUID: parent});
    }
    push({...base('assistant', id()), message: {id: `msg_${turn}_final`, type: 'message', role: 'assistant', model: 'claude-sonnet-4', content: [{type: 'text', text: markdown(rand() < 0.2 ? between(3000, 9000) : between(200, 1800))}], stop_reason: 'end_turn', usage: {input_tokens: between(10, 9000), output_tokens: between(10, 900)}}, requestId: `req_${turn}_final`});
  }
  const jsonl = rows.join('\n') + '\n';
  return {jsonl, records: rows.length, bytes: Buffer.byteLength(jsonl), conversationRecords: conversation};
}

if ((import.meta as {main?: boolean}).main) {
  const [out, turns, seed, heavy] = process.argv.slice(2);
  const fixture = generateClaudeTranscript({turns: Number(turns ?? 600), seed: Number(seed ?? 1), ...(heavy === undefined ? {} : {heavy: Number(heavy)})});
  writeFileSync(out ?? '/dev/stdout', fixture.jsonl);
  console.error(JSON.stringify({records: fixture.records, conversationRecords: fixture.conversationRecords, bytes: fixture.bytes}));
}
