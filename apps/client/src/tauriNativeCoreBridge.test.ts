import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {createTauriNativeCoreBridge} from './tauriNativeCoreBridge';

type Call = {command: string; args: Record<string, unknown>};
const fixture = JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/terminal-runtime/fixtures/control-plane.json'), 'utf8')) as {cases: {id: string; snapshots: Record<string, unknown>[]}[]};
const history = fixture.cases.find(({id}) => id === 'history')!.snapshots;

/** The app's side of the commands: answers come from `answers` in order, and every call is kept. */
function app(answers: unknown[] = []) {
  const calls: Call[] = [];
  const channel = {onmessage: (_: {type: 'changed'}) => {}};
  const inputs: unknown[][] = [];
  const open = (extra: {sessionId?: string; window?: number} = {}) => createTauriNativeCoreBridge({
    sessionId: extra.sessionId ?? 's1', scrollbackLines: 200, window: extra.window,
    invoke: async <T>(command: string, args: Record<string, unknown> = {}) => { calls.push({command, args}); return (command.endsWith('snapshot') || command.endsWith('scroll') ? answers.shift() : undefined) as T; },
    input: async (...args) => { inputs.push(args); },
    channel: () => channel,
  });
  return {calls, channel, inputs, open};
}

describe('the native core over the terminal_core commands', () => {
  it('starts watching before it hands the bridge out, and turns the app\'s doorbell into a changed event', async () => {
    const {calls, channel, open} = app();
    const bridge = await open();
    expect(calls).toEqual([{command: 'terminal_core_watch', args: {sessionId: 's1', events: channel}}]);
    const seen: unknown[] = [];
    const subscription = bridge.subscribe(event => seen.push(event));
    channel.onmessage({type: 'changed'});
    subscription.dispose();
    channel.onmessage({type: 'changed'});
    expect(seen).toEqual([{type: 'changed'}]);
  });

  it('asks for a bounded window of one session and adds the history setting the core does not know', async () => {
    const {calls, open} = app([history[0]]);
    const answer = await (await open({window: 12})).snapshot();
    expect(calls[1]).toEqual({command: 'terminal_core_snapshot', args: {sessionId: 's1', window: 12}});
    expect(answer.state).toEqual({...(history[0].state as object), scrollbackLines: 200});
    expect(answer.window).toEqual(history[0].window);
    expect(answer.events).toEqual([]);
  });

  it('reads what the program reported: a bell, the decoded directory and the clipboard write, and drops a malformed report', async () => {
    const reported = [{type: 'bell'}, {type: 'cwd', report: 'file://host/srv/a%20b'}, {type: 'cwd', report: 'nonsense'}, {type: 'cwd', report: 'http://host/no'}, {type: 'clipboard', text: 'hi'}];
    const {open} = app([{...history[0], events: reported}]);
    expect((await (await open()).snapshot()).events).toEqual([{type: 'bell'}, {type: 'cwd', path: '/srv/a b'}, {type: 'clipboard', text: 'hi'}]);
  });

  it('serves the adapter the fixture\'s answers: scrolling, modes and rows come from the core\'s text and positions', async () => {
    const {calls, open} = app([history[0], ...history.slice(1)]);
    const adapter = await openNativeTerminalAdapter(await open({window: 8}), {refreshMs: 1});
    expect(adapter.viewport()).toEqual({top: 35, rows: 5, length: 40, following: true});
    expect(adapter.readRows!(35, 5)).toEqual(['row 35', 'row 36', 'row 37', 'row 38', 'row 39']);
    adapter.scroll({kind: 'toTop'});
    adapter.scroll({kind: 'lines', delta: 3});
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(calls.filter(call => call.command === 'terminal_core_scroll').map(call => call.args.action)).toEqual([{kind: 'toTop'}, {kind: 'lines', delta: 3}]);
    expect(adapter.viewport()).toEqual({top: 3, rows: 5, length: 40, following: false});
    expect(adapter.readRows!(3, 3)).toEqual(['row 3', 'row 4', 'row 5']);
    expect(adapter.metrics().scrollbackLines).toBe(200);
    await adapter.dispose();
  });

  it('forwards input to the app\'s own input path, tells the core when it is looked at and swallows a refusal', async () => {
    const {calls, inputs, open} = app();
    const bridge = await open();
    await bridge.input('ls\r', 'keyboard');
    expect(inputs).toEqual([['ls\r', 'keyboard']]);
    bridge.setActive!(false);
    bridge.setActive!(true);
    expect(calls.slice(1)).toEqual([{command: 'terminal_core_active', args: {sessionId: 's1', active: false}}, {command: 'terminal_core_active', args: {sessionId: 's1', active: true}}]);
    const failing = await createTauriNativeCoreBridge({sessionId: 's2', scrollbackLines: 0, invoke: async command => { if (command === 'terminal_core_active') throw new Error('locked'); return undefined as never; }, input: async () => {}, channel: () => ({onmessage: () => {}})});
    expect(() => failing.setActive!(false)).not.toThrow();
  });

  it('closes the core once and stops listening', async () => {
    const {calls, channel, open} = app();
    const bridge = await open();
    const seen: unknown[] = [];
    bridge.subscribe(event => seen.push(event));
    await Promise.all([bridge.close(), bridge.close()]);
    channel.onmessage({type: 'changed'});
    expect(calls.filter(call => call.command === 'terminal_core_close')).toEqual([{command: 'terminal_core_close', args: {sessionId: 's1'}}]);
    expect(seen).toEqual([]);
  });
});
