// Records the Agent view benchmark pages with the real companion: `LAZYSH_AGENT_BIN=<lazysh-agent> bun bench/recordAgentPages.ts`.
// The pages are what `transcript --view conversation` returns for the seeded synthetic transcripts of agentFixture.ts, so their
// shape and size are the companion's own, with no private content.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateClaudeTranscript} from './agentFixture';

const binary = process.env.LAZYSH_AGENT_BIN;
if (!binary) throw new Error('Set LAZYSH_AGENT_BIN to a lazysh-agent binary');
const directory = mkdtempSync(path.join(tmpdir(), 'lazysh-agent-pages-'));
/** `typical` is an ordinary session tail; `heavy` is the companion's page cap (512 KiB) of tool output, diffs and long markdown. */
const pages = {typical: {turns: 400, seed: 1, heavy: 0.03}, heavy: {turns: 60, seed: 7, heavy: 0.4}};
for (const [name, options] of Object.entries(pages)) {
  const file = path.join(directory, `${name}.jsonl`);
  writeFileSync(file, generateClaudeTranscript({...options, images: 0}).jsonl);
  const page = execFileSync(binary, ['transcript', '--agent', 'claude', '--path', file, '--view', 'conversation', '--limit', '100'], {maxBuffer: 64 << 20});
  const target = path.join(import.meta.dirname, 'fixtures', `agent-page-${name}.json`);
  writeFileSync(target, JSON.stringify(JSON.parse(page.toString())));
  console.error(`${target}: ${page.length} bytes`);
}
