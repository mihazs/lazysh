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
