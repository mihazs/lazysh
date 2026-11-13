import {expect, test} from 'vitest';
import {generateClaudeTranscript} from './agentFixture';

test('one seed gives one transcript, and a different seed another', () => {
  const first = generateClaudeTranscript({seed: 3, turns: 20});
  expect(generateClaudeTranscript({seed: 3, turns: 20}).jsonl).toBe(first.jsonl);
  expect(generateClaudeTranscript({seed: 4, turns: 20}).jsonl).not.toBe(first.jsonl);
});

test('the records form one parent chain of the types a Claude Code session writes', () => {
  const {jsonl, records, conversationRecords} = generateClaudeTranscript({seed: 5, turns: 80, images: 2});
  const rows = jsonl.trimEnd().split('\n').map(line => JSON.parse(line) as {type: string; uuid?: string; parentUuid?: string | null; message?: {content: {type: string}[]}});
  expect(rows).toHaveLength(records);
  expect(rows.filter(row => row.uuid)).toHaveLength(conversationRecords);
  const seen = new Set<string>();
  for (const row of rows.filter(row => row.uuid)) {
    if (row.parentUuid) expect(seen.has(row.parentUuid), `${row.uuid} names a parent that comes later`).toBe(true);
    seen.add(row.uuid!);
  }
  const kinds = new Set(rows.map(row => row.type));
  for (const kind of ['user', 'assistant', 'attachment', 'system', 'queue-operation', 'file-history-snapshot']) expect(kinds.has(kind), kind).toBe(true);
  const blocks = new Set(rows.flatMap(row => row.message?.content ?? []).map(block => block.type));
  for (const kind of ['text', 'thinking', 'tool_use', 'tool_result', 'image']) expect(blocks.has(kind), kind).toBe(true);
});

test('heavy tool output makes the transcript larger', () => {
  const light = generateClaudeTranscript({seed: 6, turns: 60, heavy: 0});
  const heavy = generateClaudeTranscript({seed: 6, turns: 60, heavy: 0.5});
  expect(heavy.bytes).toBeGreaterThan(light.bytes * 1.5);
});
