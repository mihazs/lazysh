/** A Claude-shaped conversation that exercises every part of the redesigned timeline: prompt bubbles, folded activity, rich Markdown and a turn still being written. */
const code = ['```ts', 'export async function restore(key: string) {', '  const hit = await cache.get(key); // 14 ms on a warm runner', '  if (!hit) throw new Error(`cache miss for ${key} on a runner without the shared volume`);', '  return hit;', '}', '```'].join('\n');
const table = ['| Step | Before | After |', '| --- | --- | --- |', '| Install | 94 s | 12 s |', '| Build | 6 min 10 s | 3 min 41 s |', '| Test | 4 min 2 s | 4 min 2 s |'].join('\n');
const answer = [
  '## What is slow',
  'The **build** step recompiles every crate because the cache key includes `Cargo.lock` *and* the commit hash, so it never matches.',
  '',
  '- The key changes on every push',
  '- `restore-keys` falls back to nothing',
  '- Test shards repeat the same compile',
  '',
  code,
  '',
  table,
  '',
  '> Keep the key to the lock file and the toolchain. Everything else belongs in `restore-keys`.',
  '',
  '1. Drop the commit hash from the key',
  '2. Add a `restore-keys` prefix',
  '3. Share one build between the test shards',
].join('\n');
export const designMessages = [
  {id: 'p0', role: 'user', timestamp: '2026-11-13T10:30:00Z', blocks: [{type: 'text', text: 'Why is the build slow on CI? Please check it and suggest a fix.'}]},
  {id: 'a0', role: 'assistant', blocks: [{type: 'thinking', text: 'The cache key is the likely culprit.'}, {type: 'tool_use', id: 't0', name: 'Bash', text: JSON.stringify({command: 'gh run view 8841 --log | grep -c "Compiling"'})}]},
  {id: 'r0', role: 'user', blocks: [{type: 'tool_result', id: 't0', text: '412'}]},
  {id: 'a1', role: 'assistant', blocks: [{type: 'tool_use', id: 't1', name: 'Read', text: JSON.stringify({file_path: '.github/workflows/ci.yml'})}]},
  {id: 'r1', role: 'user', blocks: [{type: 'tool_result', id: 't1', text: 'name: ci\non: [push]'}]},
  {id: 'a2', role: 'assistant', blocks: [{type: 'text', text: answer}]},
  {id: 'p1', role: 'user', blocks: [{type: 'text', text: 'Apply the first one.'}]},
  {id: 'a3', role: 'assistant', blocks: [{type: 'tool_use', id: 't2', name: 'Edit', text: JSON.stringify({file_path: '.github/workflows/ci.yml', old_string: 'key: ${{ hashFiles(\'Cargo.lock\') }}-${{ github.sha }}', new_string: 'key: ${{ hashFiles(\'Cargo.lock\') }}'})}]},
  {id: 'r2', role: 'user', blocks: [{type: 'tool_result', id: 't2', text: 'The file has been updated.'}]},
  {id: 'a4', role: 'assistant', blocks: [{type: 'text', text: 'Done. The key is now the lock file alone, so a push without dependency changes restores the whole build.'}]},
  {id: 'p2', role: 'user', blocks: [{type: 'text', text: 'Great. Now do the same for the test shards, and make sure the docs mention the new key:\n\n- the contributor guide\n- the CI reference'}]},
];

/** The part of a conversation that is mostly work: thinking, calls in every state, a plan, a sub-agent, a question and a failure; the last turn is still running. */
const call = (id: string, name: string, input: unknown) => ({type: 'tool_use', id, name, text: JSON.stringify(input)});
const result = (id: string, text: string, isError = false) => ({type: 'tool_result', id, text, ...(isError ? {isError} : {})});
export const workMessages = [
  {id: 'w-p0', role: 'user', blocks: [{type: 'text', text: 'Make the retry test stable, then run the whole suite.'}]},
  {id: 'w-a0', role: 'assistant', blocks: [{type: 'thinking', text: 'The test sleeps for a fixed time. A fake clock would make it deterministic.'}, call('w-t0', 'Read', {file_path: 'src/sync.test.ts'})]},
  {id: 'w-r0', role: 'user', blocks: [result('w-t0', 'import {sync} from "./sync";')]},
  {id: 'w-a1', role: 'assistant', blocks: [{...call('w-t1', 'TodoWrite', {}), card: {kind: 'plan', entries: [{text: 'Use a fake clock in the retry test', status: 'completed'}, {text: 'Run the whole suite', status: 'in_progress'}, {text: 'Update the contributor guide', status: 'pending'}]}}]},
  {id: 'w-r1', role: 'user', blocks: [result('w-t1', 'Todos have been modified successfully')]},
  {id: 'w-a2', role: 'assistant', blocks: [call('w-t2', 'Edit', {file_path: 'src/sync.test.ts', old_string: 'await sleep(5000);', new_string: 'await clock.tickAsync(5000);'})]},
  {id: 'w-r2', role: 'user', blocks: [result('w-t2', 'The file src/sync.test.ts has been updated.')]},
  {id: 'w-a3', role: 'assistant', blocks: [call('w-t3', 'Bash', {command: 'bun test src/sync.test.ts'})]},
  {id: 'w-r3', role: 'user', blocks: [result('w-t3', 'Exit code 1\nerror: expected 3 attempts, received 2\n  at src/sync.test.ts:41', true)]},
  {id: 'w-a4', role: 'assistant', blocks: [call('w-t4', 'Agent', {description: 'Audit the other retry tests', subagent_type: 'general-purpose', prompt: 'Find tests that sleep.'}), call('w-t5', 'Bash', {command: 'bun test'})]},
  {id: 'w-r4', role: 'user', blocks: [result('w-t4', 'Found two more tests that sleep.')]},
  {id: 'w-a5', role: 'assistant', blocks: [{type: 'text', text: 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}', card: {kind: 'error', cause: 'server_error'}}]},
];
/** Mid-turn: the agent asks a question and waits for the answer. */
export const questionMessages = [
  {id: 'q-p0', role: 'user', blocks: [{type: 'text', text: 'Set up the release workflow.'}]},
  {id: 'q-a0', role: 'assistant', blocks: [{type: 'text', text: 'Before I write it, one choice decides the layout.'}, {...call('q-t0', 'AskUserQuestion', {}), card: {kind: 'question', questions: [{question: 'Which registry should the release publish to?', header: 'Registry', multiple: false, options: [{label: 'npm', description: 'Public packages, provenance on'}, {label: 'GitHub Packages', description: 'Scoped to the organisation'}]}]}}]},
];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
export const designWork = [
  {id: 'w-t4', kind: 'agent', title: 'Audit the other retry tests', subtitle: 'general-purpose', state: 'done', startedAt: ago(4), endedAt: ago(1), events: [], summary: 'Found two more tests that sleep.'},
  {id: 'w-m1', kind: 'monitor', title: 'CI checks', command: 'gh pr checks 1452', state: 'running', startedAt: ago(3), events: ['lint: pass', 'tests: running'], last: 'tests: running'},
  {id: 'w-b1', kind: 'shell', title: 'Dev server', command: 'bun run dev', state: 'running', startedAt: ago(9), events: []},
];
