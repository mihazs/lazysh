import {describe, expect, it} from 'vitest';
import {describeTool, tail, toolKind} from './agentToolCall';
import {fileChanges, replacement} from './agentDiff';

const use = (name: string, input: object | string, status?: 'completed' | 'failed' | 'pending') => ({name, text: typeof input === 'string' ? input : JSON.stringify(input), status});

describe('describeTool', () => {
  it('maps each recorded Claude Code and Codex tool to a kind and a one-line summary', () => {
    expect(describeTool(use('Bash', {command: 'cargo test\n--all', description: 'Test'}))).toMatchObject({kind: 'execute', summary: 'cargo test'});
    // A Codex command is plain text, not JSON.
    expect(describeTool(use('command', 'git status --short'))).toMatchObject({kind: 'execute', summary: 'git status --short'});
    expect(describeTool(use('Read', {file_path: '/repo/a.ts', offset: 10, limit: 20}))).toMatchObject({kind: 'read', summary: '/repo/a.ts:10-29'});
    expect(describeTool(use('Read', {file_path: '/repo/a.ts'})).summary).toBe('/repo/a.ts');
    expect(describeTool(use('Grep', {pattern: 'TODO', path: 'src'}))).toMatchObject({kind: 'search', summary: 'TODO in src'});
    expect(describeTool(use('Glob', {pattern: '**/*.rs'})).summary).toBe('**/*.rs');
    expect(describeTool(use('WebFetch', {url: 'https://example.com/x', prompt: 'summarise'}))).toMatchObject({kind: 'fetch', summary: 'https://example.com/x'});
    expect(describeTool(use('WebSearch', {query: 'tauri acl'}))).toMatchObject({kind: 'fetch', summary: 'tauri acl'});
    expect(describeTool(use('Edit', {file_path: '/repo/a.ts', old_string: 'a', new_string: 'b'}))).toMatchObject({kind: 'edit', summary: '/repo/a.ts'});
  });
  it('maps the Gemini CLI tool names to the same kinds, with its own input names', () => {
    expect(describeTool(use('run_shell_command', {command: 'npm test', description: 'Run the tests'}))).toMatchObject({kind: 'execute', summary: 'npm test'});
    expect(describeTool(use('read_file', {file_path: '/repo/a.ts'}))).toMatchObject({kind: 'read', summary: '/repo/a.ts'});
    expect(describeTool(use('grep_search', {pattern: 'TODO'}))).toMatchObject({kind: 'search', summary: 'TODO'});
    expect(describeTool(use('google_web_search', {query: 'tauri acl'}))).toMatchObject({kind: 'fetch', summary: 'tauri acl'});
    expect(fileChanges(describeTool(use('replace', {file_path: '/repo/a.ts', instruction: 'rename', old_string: 'a', new_string: 'b'})))).toMatchObject([{path: '/repo/a.ts', added: 1, removed: 1}]);
    expect(fileChanges(describeTool(use('write_file', {file_path: '/repo/b.ts', content: 'one\ntwo\n'})))).toMatchObject([{path: '/repo/b.ts', added: 2, removed: 0}]);
  });
  it('keeps an unknown or MCP tool as other with its name and its first value', () => {
    const call = describeTool(use('mcp__github__create_issue', {title: 'Fix the thing', body: 'x'}));
    expect([call.kind, call.name, call.summary]).toEqual(['other', 'mcp__github__create_issue', 'Fix the thing']);
    expect(toolKind(undefined)).toBe('other');
  });
  it('is running until its result arrives, then ok, error with the exit code, or denied', () => {
    const call = use('Bash', {command: 'make'});
    expect(describeTool(call).status).toBe('running');
    expect(describeTool(call, {text: 'built', isError: false})).toMatchObject({status: 'ok', output: 'built'});
    const failed = describeTool(call, {text: 'Exit code 2\nmake: *** [all] Error 1', isError: true});
    expect([failed.status, failed.exitCode, failed.output]).toEqual(['error', 2, 'make: *** [all] Error 1']);
    // A refusal is not a failure of the tool.
    expect(describeTool(call, {text: "The user doesn't want to proceed with this tool use. The tool use was rejected.", isError: true}).status).toBe('denied');
    expect(describeTool(call, {text: 'Permission to use Bash has been denied.', isError: true}).status).toBe('denied');
    expect(describeTool(call, {text: 'tests mention "Exit code 3"', isError: false}).exitCode).toBeUndefined();
  });
  it("uses a call's own recorded status when no result block exists", () => {
    expect(describeTool(use('command', 'ls', 'completed')).status).toBe('ok');
    expect(describeTool(use('command', 'ls', 'failed')).status).toBe('error');
    expect(describeTool(use('command', 'ls', 'pending')).status).toBe('running');
  });
  it('tails the output and reports how many lines were left out', () => {
    expect(tail('a\nb\nc\nd\n', 2)).toEqual({lines: 'c\nd', hidden: 2});
    expect(tail('a', 20)).toEqual({lines: 'a', hidden: 0});
  });
});

describe('fileChanges', () => {
  const lines = (change: {lines: {kind: string; text: string}[]}) => change.lines.map(line => line.kind + line.text);
  it('reads an Edit as removed and added lines with two lines of context around the changed ones', () => {
    const [change] = fileChanges(describeTool(use('Edit', {file_path: 'a.ts', old_string: 'one\ntwo\nthree\nfour\nfive\nsix\nseven', new_string: 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven'})));
    expect(lines(change)).toEqual([' two', ' three', '-four', '+FOUR', ' five', ' six']);
    expect([change.added, change.removed, change.path]).toEqual([1, 1, 'a.ts']);
  });
  it('reads a MultiEdit as one file with its replacements apart, and a Write as all added lines', () => {
    const [multi] = fileChanges(describeTool(use('MultiEdit', {file_path: 'b.ts', edits: [{old_string: 'a', new_string: 'b'}, {old_string: 'c\nd', new_string: 'c'}]})));
    expect(lines(multi)).toEqual(['-a', '+b', ' …', ' c', '-d']);
    expect([multi.added, multi.removed]).toEqual([1, 2]);
    const [write] = fileChanges(describeTool(use('Write', {file_path: 'new.txt', content: 'x\ny\n'})));
    expect([write.added, write.removed, lines(write)]).toEqual([2, 0, ['+x', '+y']]);
  });
  it('reads a patch per file and has no diff for a call that carries none', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.rs\n@@\n-old\n+new\n ctx\n*** Add File: b.rs\n+hello\n*** End Patch';
    const changes = fileChanges(describeTool(use('apply_patch', patch)));
    expect(changes.map(change => [change.path, change.added, change.removed])).toEqual([['src/a.rs', 1, 1], ['b.rs', 1, 0]]);
    expect(fileChanges(describeTool(use('Edit', {file_path: 'a.ts'})))).toEqual([]);
    expect(fileChanges(describeTool(use('Bash', {command: 'ls'})))).toEqual([]);
  });
  it('reads OpenCode edits, which name their input in camelCase', () => {
    const [edit] = fileChanges(describeTool(use('edit', {filePath: '/w/a.json', oldString: 'a\nold\nz', newString: 'a\nnew\nz'})));
    expect([edit.path, edit.added, edit.removed]).toEqual(['/w/a.json', 1, 1]);
    const [patch] = fileChanges(describeTool(use('apply_patch', {patchText: '*** Begin Patch\n*** Update File: /w/b.md\n@@\n-x\n+y\n*** End Patch'})));
    expect([patch.path, patch.added, patch.removed]).toEqual(['/w/b.md', 1, 1]);
  });
  it('shows no line for identical text', () => {
    expect(replacement('same\n', 'same\n').filter(line => line.kind !== ' ')).toEqual([]);
  });
});
