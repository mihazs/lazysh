// In-page half of the Agent view load benchmark (docs/reference/agent-view-performance.md). It mounts the real AgentView in a
// production build against a modelled host: every native command answers after the delay its SSH cost implies, with the page the
// real companion recorded for the seeded fixture (bench/recordAgentPages.ts). The Playwright driver adds CDP throttling and traces.
import {Profiler, type ProfilerOnRenderCallback} from 'react';
import {createRoot} from 'react-dom/client';
import AgentView from '../src/AgentView';
import {accessSnapshot, applyAccessStatus} from '../src/access';
import {tmuxChatSnapshot} from '../src/test/tmuxChat';
import typicalUrl from './fixtures/agent-page-typical.json?url';
import heavyUrl from './fixtures/agent-page-heavy.json?url';

/** SSH cost model. `execMs` is one host exec (a probe, a snapshot, a transcript read); `execs` is how many each native command runs. */
export type Model = {execMs: number; controlMs: number; hostMs: number; page: 'typical' | 'heavy'; stream: boolean; mode: 'tmux' | 'herdr';
  /** The exec counts of the baseline commit 9d0da93e: every companion command repeated the probe, the Herdr conversation read ran four execs. */
  legacy: boolean;
  /** Sequential execs per native command. */
  execs: Record<string, number>};
const LEGACY_EXECS = {agent_snapshot: 2, agent_reported_history: 2, agent_transcript: 2, agent_watch_start: 2, multiplexer_sessions: 1, herdr_tree: 1, agent_herdr_conversation: 4};
/** With the host probe cached the command is the only exec; a Herdr conversation read is the tree check overlapped with the conversation,
 * then the tree again. The first companion command of a connection also waits for the one probe exec (`probe` below). */
const EXECS = {agent_snapshot: 1, agent_reported_history: 1, agent_transcript: 1, agent_watch_start: 1, multiplexer_sessions: 1, herdr_tree: 1, agent_herdr_conversation: 2};
export const DEFAULT_MODEL: Model = {execMs: 8, controlMs: 4, hostMs: 90, page: 'typical', stream: true, mode: 'tmux', legacy: false, execs: EXECS};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const painted = async () => { await frame(); await frame(); return performance.now(); };
const pages = {typical: typicalUrl, heavy: heavyUrl};
const texts = new Map<string, string>();
const sessionId = '11111111-1111-4111-8111-111111111111', pane = '%3', path = '/home/owner/.claude/projects/bench/11111111-1111-4111-8111-111111111111.jsonl';

let model = DEFAULT_MODEL;
let started = 0;
const calls: {command: string; start: number; end: number}[] = [];
const commits: {phase: string; actual: number; start: number; commit: number}[] = [];
const onRender: ProfilerOnRenderCallback = (_id, phase, actual, _base, start, commit) => { commits.push({phase, actual, start, commit}); };
let probe: Promise<void> | undefined;
let watch: {onmessage: (event: unknown) => void} | undefined;
let page: Record<string, unknown> & {messages: {id: string}[]};
let dispose = () => {};

async function load(name: Model['page']) {
  if (!texts.has(name)) texts.set(name, await (await fetch(pages[name])).text());
  return texts.get(name)!;
}
/** One Herdr workspace whose focused pane runs the Claude Code agent this benchmark reads. */
const herdrTree = () => {
  const pane = {workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: 'term-1', cwd: '/work/project', agent_status: 'working', focused: true};
  return {workspaces: [{workspace_id: 'w1', label: '[1] project', focused: true, agent_status: 'working'}], tabs: [{workspace_id: 'w1', tab_id: 'w1:t1', label: 'tab', number: 1, focused: true, agent_status: 'working'}], panes: [pane],
    agents: [{terminal_id: 'term-1', workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', name: null, agent: 'claude', agent_status: 'working', agent_session: {source: 'herdr:claude', agent: 'claude', kind: 'id', value: sessionId}}]};
};
const entries = (messages: {id: string}[]) => messages.map(message => ({id: message.id, rev: 1, message}));

const companionCommands = new Set(['agent_snapshot', 'agent_reported_history', 'agent_transcript', 'agent_watch_start', 'multiplexer_sessions', 'herdr_tree', 'agent_herdr_conversation']);
async function native(command: string, args: Record<string, unknown>) {
  const start = performance.now();
  // The host probe runs once per connection, and the commands that start together share it.
  if (!model.legacy && companionCommands.has(command)) await (probe ??= sleep(model.execMs));
  const wait = async (ms: number) => { await sleep(ms); };
  let result: unknown;
  switch (command) {
    case 'multiplexer_sessions':
      await wait(model.execs.multiplexer_sessions * model.execMs);
      result = [{name: 'owned'}];
      break;
    case 'herdr_tree':
      await wait(model.execs.herdr_tree * model.execMs);
      result = herdrTree();
      break;
    case 'agent_herdr_conversation':
      await wait(model.execs.agent_herdr_conversation * model.execMs + model.hostMs);
      result = JSON.parse(await load(model.page));
      break;
    case 'agent_snapshot':
      await wait(model.execs.agent_snapshot * model.execMs);
      result = {schemaVersion: 1, sessions: [{sessionId, agent: 'Claude Code', project: '/work/project', state: 'working', updatedAt: new Date().toISOString(), summary: 'Working', paneId: pane, eventCount: 4}]};
      break;
    case 'tmux_chat': {
      await wait(model.controlMs);
      const action = args.action as {kind: string};
      result = action.kind === 'snapshot' ? {...tmuxChatSnapshot, destination: {...tmuxChatSnapshot.destination, paneId: pane}} : undefined;
      break;
    }
    case 'agent_reported_history':
      await wait(model.execs.agent_reported_history * model.execMs);
      result = {schemaVersion: 1, sessionId, status: 'available', path, reportedAt: '2026-11-13T00:00:00Z', paneId: pane};
      break;
    case 'agent_transcript':
      await wait(model.execs.agent_transcript * model.execMs + model.hostMs);
      result = JSON.parse(await load(model.page));
      break;
    case 'agent_watch_start': {
      await wait(model.execs.agent_watch_start * model.execMs);
      const channel = args.events as typeof watch;
      watch = channel;
      if (!model.stream) { setTimeout(() => channel!.onmessage({type: 'unavailable', reason: 'companion_required'})); result = 'watch-1'; break; }
      await wait(model.hostMs);
      const snapshot = JSON.parse(await load(model.page)) as typeof page;
      setTimeout(() => {
        channel!.onmessage({type: 'frame', frame: {type: 'hello', protocol: 1, agent: 'claude'}});
        channel!.onmessage({type: 'frame', frame: {type: 'snapshot', gen: 1, seq: 1, entries: entries(snapshot.messages.slice(-50))}});
      });
      result = 'watch-1';
      break;
    }
    default: result = command.startsWith('plugin:event|') ? 1 : undefined;
  }
  calls.push({command, start: start - started, end: performance.now() - started});
  return result;
}

function install() {
  Object.defineProperty(window, 'isTauri', {value: true});
  Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: (command: string, args: Record<string, unknown> = {}) => native(command, args),
  }});
}

/** Counts the long tasks and the frame intervals of a window of activity. */
function meter() {
  const tasks: {start: number; duration: number}[] = [], intervals: number[] = [];
  const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => tasks.push({start: entry.startTime - started, duration: entry.duration})));
  try { observer.observe({type: 'longtask', buffered: false}); } catch { /* unavailable */ }
  let last: number | undefined, running = true;
  const tick = (time: number) => { if (!running) return; if (last !== undefined) intervals.push(time - last); last = time; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return {stop() { running = false; observer.takeRecords().forEach(entry => tasks.push({start: entry.startTime - started, duration: entry.duration})); observer.disconnect(); return {tasks, intervals}; }};
}

async function open(next: Partial<Model> = {}) {
  model = {...DEFAULT_MODEL, ...next, execs: {...DEFAULT_MODEL.execs, ...next.execs}};
  model.controlMs = Math.max(4, model.execMs / 2);
  if (model.legacy) model.execs = LEGACY_EXECS;
  dispose();
  calls.length = 0; commits.length = 0; watch = undefined; probe = undefined;
  install();
  applyAccessStatus({initialized: true, supported: true, reason: 'Synthetic benchmark fixture.', enabled: true, locked: false, generation: String(BigInt(accessSnapshot().status?.generation ?? '0') + 1n), nonce: 'a'.repeat(64)});
  const host = document.createElement('div');
  Object.assign(host.style, {position: 'fixed', inset: '0', display: 'grid', background: 'var(--background)'});
  document.body.append(host);
  const loading = meter();
  started = performance.now();
  const root = createRoot(host);
  dispose = () => { root.unmount(); host.remove(); dispose = () => {}; };
  root.render(<Profiler id="agent-view" onRender={onRender}><AgentView sessionId="bench" shown tmux={model.mode === 'tmux'} herdrSession={model.mode === 'herdr' ? 'owned' : undefined} onShowTerminal={() => {}} /></Profiler>);
  // First content: the first message bubble in the DOM, then the frame that paints it.
  const first = await new Promise<number>((resolve, reject) => {
    const look = () => host.querySelector('.agent-bubble') ? resolve(performance.now()) : performance.now() - started > 15_000 ? reject(new Error(`No message after 15 s; commands: ${calls.map(call => call.command).join(',')}`)) : requestAnimationFrame(look);
    look();
  });
  const firstPainted = await painted();
  const firstContentMs = firstPainted - started, domAtFirst = host.querySelectorAll('*').length;
  // Settled: the page is complete and the stream (when there is one) has replaced it.
  await sleep(model.stream ? 1500 : 800);
  const {tasks, intervals} = loading.stop();
  return {model, firstContentMs, firstDomMs: first - started, domAtFirst, domNodes: host.querySelectorAll('*').length, bubbles: host.querySelectorAll('.agent-bubble').length, calls: calls.map(call => ({...call})),
    commits: commits.map(commit => ({...commit, start: commit.start - started, commit: commit.commit - started})), longTasks: tasks, frameIntervals: intervals};
}

/** Scrolls the timeline from newest to oldest in fixed steps and reports the frame intervals and long tasks of the run. */
async function scroll(steps = 120) {
  const scroller = document.querySelector<HTMLElement>('.chat-messages')!;
  const metering = meter();
  const total = scroller.scrollHeight - scroller.clientHeight;
  for (let step = 0; step < steps; step++) { scroller.scrollTop = Math.max(0, total - (total * (step + 1)) / steps); await frame(); }
  const {tasks, intervals} = metering.stop();
  return {scrollHeight: scroller.scrollHeight, intervals, longTasks: tasks.map(task => task.duration)};
}

/** Streams `count` deltas into the newest assistant message, one per `everyMs`, and returns the render cost per delta. */
async function stream(count = 40, everyMs = 80) {
  const before = commits.length, metering = meter(), latencies: number[] = [];
  const last = (JSON.parse(await load(model.page)) as typeof page).messages.at(-1)!;
  const message = last as typeof last & {blocks: {type: string; text?: string}[]};
  const base = message.blocks.map(block => ({...block}));
  for (let index = 1; index <= count; index++) {
    const blocks = base.map(block => block.type === 'text' ? {...block, text: `${block.text ?? ''}${' streamed words'.repeat(index)}`} : block);
    const sent = performance.now();
    watch!.onmessage({type: 'frame', frame: {type: 'delta', gen: 1, seq: index + 1, upserts: [{id: message.id, rev: index + 1, message: {...message, blocks}}], drops: []}});
    await painted();
    latencies.push(performance.now() - sent);
    await sleep(everyMs);
  }
  const {tasks} = metering.stop();
  return {latencies, commits: commits.length - before, longTasks: tasks.map(task => task.duration), actualMs: commits.slice(before).map(commit => commit.actual)};
}

declare global { interface Window { agentBench: {open: typeof open; scroll: typeof scroll; stream: typeof stream; build: string}; } }
window.agentBench = {open, scroll, stream, build: import.meta.env.PROD ? 'production' : 'development'};
