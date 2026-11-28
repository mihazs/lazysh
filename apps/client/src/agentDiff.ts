/** The file changes a recorded edit call carries in its own input, as diff lines. Pure.
 * Claude Code's `Edit` and `MultiEdit` record the replaced and the new text, `Write` the whole file, `NotebookEdit` the new cell source,
 * and a patch (`*** Update File:` blocks) is read as written. A call whose input holds none of these has no diff card. */
import type {ToolCall} from './agentToolCall';

export type DiffLine = {kind: '+' | '-' | ' '; text: string};
export type FileOp = 'create' | 'edit' | 'delete' | 'rename';
/** `from` is the old path of a rename; `path` is always the file as it is after the change (or the deleted file). */
export type FileChange = {path: string; op: FileOp; from?: string; lines: DiffLine[]; added: number; removed: number};

const CONTEXT = 2;
const split = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** The lines of one replacement: the lines both texts share at the start and the end are context, the rest is removed and added.
 * shortcut: no line matching inside the changed middle, which is as small as the agent's own old and new strings; use a real diff if a call ever carries whole files. */
export function replacement(before: string, after: string): DiffLine[] {
  const old = split(before), now = split(after);
  let head = 0;
  while (head < old.length && head < now.length && old[head] === now[head]) head++;
  let foot = 0;
  while (foot < old.length - head && foot < now.length - head && old[old.length - 1 - foot] === now[now.length - 1 - foot]) foot++;
  return [
    ...old.slice(Math.max(0, head - CONTEXT), head).map(text => ({kind: ' ' as const, text})),
    ...old.slice(head, old.length - foot).map(text => ({kind: '-' as const, text})),
    ...now.slice(head, now.length - foot).map(text => ({kind: '+' as const, text})),
    ...old.slice(old.length - foot, old.length - foot + CONTEXT).map(text => ({kind: ' ' as const, text})),
  ];
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const change = (path: string, lines: DiffLine[], op: FileOp = 'edit', from?: string): FileChange => ({path, op, from, lines, added: lines.filter(line => line.kind === '+').length, removed: lines.filter(line => line.kind === '-').length});

const PATCH_OPS = {Add: 'create', Update: 'edit', Delete: 'delete'} as const;

function patches(text: string): FileChange[] {
  const files: {path: string; op: FileOp; from?: string; lines: DiffLine[]}[] = [];
  for (const line of text.split('\n')) {
    const file = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line), move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (file) files.push({path: file[2].trim(), op: PATCH_OPS[file[1] as keyof typeof PATCH_OPS], lines: []});
    else if (move && files.length) Object.assign(files.at(-1)!, {op: 'rename', from: files.at(-1)!.path, path: move[1].trim()});
    else if (files.length && /^[+\- ]/.test(line)) files.at(-1)!.lines.push({kind: line[0] as DiffLine['kind'], text: line.slice(1)});
  }
  return files.map(file => change(file.path, file.lines, file.op, file.from));
}

export function fileChanges(call: ToolCall): FileChange[] {
  if (call.kind !== 'edit') return [];
  const {input} = call;
  const path = str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? str(input.notebook_path) ?? '';
  const patch = str(input.command) ?? str(input.input) ?? str(input.patch) ?? str(input.patchText);
  if (patch?.includes('*** Begin Patch') || patch?.includes('*** Update File:')) return patches(patch);
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const replaced = edits.flatMap(edit => {
    const row = edit as Record<string, unknown>, before = str(row.old_string) ?? str(row.old_str) ?? str(row.oldString), after = str(row.new_string) ?? str(row.new_str) ?? str(row.newString);
    return before !== undefined && after !== undefined ? [replacement(before, after)] : [];
  });
  if (replaced.length) return [change(path, replaced.flatMap((lines, index) => (index ? [{kind: ' ' as const, text: '…'}, ...lines] : lines)))];
  const written = str(input.content) ?? str(input.new_source);
  // A whole-file write is a create only when the tool says so (Claude Code: "File created successfully"); an overwrite is an edit.
  return written !== undefined ? [change(path, split(written).map(text => ({kind: '+' as const, text})), /\bcreated\b/i.test(call.output ?? '') ? 'create' : 'edit')] : [];
}
