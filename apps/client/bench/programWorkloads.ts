// W5 to W8 and W11 of docs/architecture/terminal-benchmarks.md as renderer-neutral, replayable workloads: recorded program sessions
// (the conformance captures of packages/terminal-runtime/fixtures), the captured Mosh frames and a seeded agent stream. The xterm.js page
// (e2e/terminal-programs.spec.ts) and the native core (packages/terminal-runtime/examples/program_workloads.rs) replay the same bytes
// and hold the same screens. Node only: the page receives each workload as JSON from the spec, the core reads `bun bench/programWorkloads.ts <file>`.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentStream, chunks } from './workloads';

const fixtures = path.resolve(import.meta.dirname, '../../../packages/terminal-runtime/fixtures');
const moshFrames = path.resolve(import.meta.dirname, '../e2e/fixtures/mosh-resize-frames.json');

/** What the terminal must show after a step: the screen (rows without trailing blanks) and the cursor, or for a Mosh frame its size, cursor and second row. */
export type Check = { cursor: [x: number, y: number]; lines?: string[]; size?: [cols: number, rows: number]; row1?: string };
export type Replay = {
  id: 'W5' | 'W6' | 'W7' | 'W8' | 'W11';
  title: string;
  variant: string;
  /** The fixture the bytes and the checks come from. */
  source: string;
  /** The geometry the program was recorded at: the terminal is made that size (a Mosh frame carries its own). */
  cols: number;
  rows: number;
  /**
   * `stream`: the steps are the bytes the remote delivered, in order.
   * `mosh`: each step is the body of one display update, which the runner wraps in the begin and end envelopes (`moshEnvelope`) at the size its check names.
   */
  kind: 'stream' | 'mosh';
  /** A stream that ends on the screen it starts on (every capture here was checked to end on the same screen after any number of replays): a runner may deliver it many times in a row to reach a volume. */
  repeatable: boolean;
  /** What arrives in one piece (a 16 KiB chunk of a stream, one agent write, one Mosh body), base64. */
  steps: string[];
  /** One per step; a stream is checked after its last step only. */
  checks: (Check | null)[];
  bytes: number;
  sha256: string;
};

type Meta = Pick<Replay, 'id' | 'title' | 'variant'>;
type Fixture = { id: string; cols: number; rows: number; steps: { writeFile: string }[]; expect: { lines: string[]; cursor: { x: number; y: number } } };
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

function replay(meta: Meta, source: string, size: [number, number], kind: Replay['kind'], parts: Uint8Array[], checks: (Check | null)[], repeatable = false): Replay {
  const hash = createHash('sha256');
  parts.forEach(part => hash.update(part));
  return { ...meta, source, cols: size[0], rows: size[1], kind, repeatable, steps: parts.map(part => Buffer.from(part).toString('base64')), checks, bytes: parts.reduce((n, part) => n + part.length, 0), sha256: hash.digest('hex') };
}
const last = (count: number, check: Check) => [...Array(count - 1).fill(null), check];

/** A capture of `fixtures/vt/captures.json`: its bytes chunked as the Rust session workers chunk a pty, against the `expect` xterm.js 5.5.0 produced (the core meets the same screen; its divergences are terminal replies). */
function capture(meta: Meta, id: string): Replay {
  const found = (json(path.join(fixtures, 'vt/captures.json')) as Fixture[]).find(fixture => fixture.id === id);
  if (!found) throw new Error(`No capture fixture ${id}`);
  const parts = found.steps.flatMap(step => chunks(new Uint8Array(readFileSync(path.join(fixtures, step.writeFile)))));
  return replay(meta, `fixtures/vt/captures.json#${id}`, [found.cols, found.rows], 'stream', parts, last(parts.length, { lines: found.expect.lines, cursor: [found.expect.cursor.x, found.expect.cursor.y] }), true);
}

type MoshFrame = { cols: number; rows: number; bodyHex: string; expectedCursor: [number, number]; expectedLongRow: string };
/** Captured Mosh display updates, as the e2e specs and tests/mosh.rs replay them. */
function mosh(meta: Meta, frames: MoshFrame[]): Replay {
  return replay(meta, 'e2e/fixtures/mosh-resize-frames.json', [frames[0].cols, frames[0].rows], 'mosh', frames.map(frame => Buffer.from(frame.bodyHex, 'hex')),
    frames.map(frame => ({ cursor: frame.expectedCursor, size: [frame.cols, frame.rows], row1: frame.expectedLongRow })));
}

/** `agentTokens` sizes the seeded agent stream (W8): its screen depends on how many writes it has. */
export function programWorkloads({ agentTokens }: { agentTokens: number }): Replay[] {
  const frames = json(moshFrames).frames as MoshFrame[];
  const agent = agentStream({ tokens: agentTokens, cols: 100, rows: 30, seed: 80 });
  return [
    capture({ id: 'W5', title: 'vim editing session', variant: 'vim 9 on a three-line file: insert, :set number, gg, :q!' }, 'capture-vim-edit'),
    capture({ id: 'W6', title: 'tmux session', variant: 'tmux 3: two splits and a coloured printf' }, 'capture-tmux-splits'),
    capture({ id: 'W6', title: 'Zellij session', variant: 'Zellij 0.46: a command, a new pane and a command in it' }, 'capture-zellij-panes'),
    mosh({ id: 'W7', title: 'Mosh resize', variant: 'six captured display updates, five of which change the size' }, frames),
    mosh({ id: 'W7', title: 'Mosh reconnect', variant: 'the first captured display update, on a fresh terminal' }, frames.slice(0, 1)),
    capture({ id: 'W8', title: 'Agent screens', variant: 'Claude Code 2.1 first run: theme picker to login method' }, 'capture-claude-onboarding'),
    capture({ id: 'W8', title: 'Agent screens', variant: 'Codex 0.167 first run: sign-in menu' }, 'capture-codex-login'),
    capture({ id: 'W8', title: 'Agent screens', variant: 'OpenCode 2.2 home screen, text typed and cleared' }, 'capture-opencode-home'),
    replay({ id: 'W8', title: 'Agent streaming', variant: 'seeded: a few words per write, the live region redrawn after each' }, `bench/workloads.ts agentStream(${agentTokens} tokens, seed 80)`, [100, 30], 'stream', agent.steps, last(agent.steps.length, { lines: agent.screen, cursor: agent.cursor })),
    capture({ id: 'W11', title: 'Background and resume', variant: 'Herdr 0.9 session, hidden while it redraws, then shown and its surface recreated' }, 'capture-herdr-session'),
  ];
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error('usage: bun bench/programWorkloads.ts <file> [agent tokens]'); process.exit(2); }
  const all = programWorkloads({ agentTokens: Number(process.argv[3]) || 300 });
  writeFileSync(file, JSON.stringify(all));
  console.log(`${file}: ${all.length} workloads, ${all.reduce((n, replay) => n + replay.bytes, 0)} bytes of steps`);
}
