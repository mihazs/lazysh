// @vitest-environment jsdom
import {invoke} from '@tauri-apps/api/core';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import ChatPanel from './ChatPanel';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn(),Channel:class{onmessage:((event:unknown)=>void)|undefined;}}));
vi.mock('react-markdown',()=>({default:({children}:{children:string})=>children}));

const PAGE = 50;
let TOTAL = 12_000;
const message = (n: number) => ({id: `m${n}`, role: n % 2 ? 'assistant' : 'user', blocks: [{type: 'text', text: `message ${n}`}]});
/** What the host companion answers for a window of a 12k message session. */
function host(window?: {before?: string; after?: string; fromStart?: boolean}) {
  const index = (id: string) => Number(id.slice(1));
  let from = TOTAL - PAGE;
  if (window?.fromStart) from = 0;
  else if (window?.before) from = Math.max(0, index(window.before) - PAGE);
  else if (window?.after) from = index(window.after) + 1;
  const to = window?.before ? index(window.before) : Math.min(TOTAL, from + PAGE);
  return {schemaVersion: 1, agent: 'claude', view: 'active_branch', nextOffset: 0, hasMore: false, branchId: 'u', truncated: from > 0,
    ...(to < TOTAL ? {hasNewer: true} : {}), messages: Array.from({length: to - from}, (_, offset) => message(from + offset))};
}
/** Messages on screen: the ones inside a closed fold take no room. */
const shownRows = (root: ParentNode = document) => Array.from(root.querySelectorAll('article')).filter(node => !node.closest('details:not([open])')).length;
/** One prompt, then 199 records of autonomous work: a command and its result, and every tenth record something the agent says. */
const work = (n: number) => n === 0 ? {id: 'm0', role: 'user', blocks: [{type: 'text', text: 'Do the long job'}]}
  : n % 10 === 0 ? {id: `m${n}`, role: 'assistant', blocks: [{type: 'text', text: `note ${n}`}]}
  : n % 2 ? {id: `m${n}`, role: 'assistant', blocks: [{type: 'tool_use', id: `t${n}`, name: 'Bash', text: 'ls'}]}
  : {id: `m${n}`, role: 'tool', blocks: [{type: 'tool_result', id: `t${n - 1}`, text: 'ok'}]};
let oldCompanion: boolean;
const transcriptCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'agent_transcript').map(([, args]) => (args as {window?: unknown}).window);
const articles = () => screen.queryAllByRole('article').map(node => node.textContent);

beforeEach(() => {
  vi.mocked(invoke).mockReset(); access(); oldCompanion = false; TOTAL = 12_000;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'agent_transcript') {
      const window = (args as {window?: Parameters<typeof host>[0]}).window;
      if (window && oldCompanion) throw new Error("error: unexpected argument '--before' found");
      return host(window);
    }
    if (command === 'agent_watch_start') throw new Error('no channel');
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(cleanup);

const open = async () => {
  render(<ChatPanel sessionId="host" bound={{agent: 'claude', path: '/host/session.jsonl'}} />);
  await screen.findByText(`message ${TOTAL - 1}`);
};

describe('reading a 12k message session from the Agent view', () => {
  it('opts into Codex history paging and reaches the start', async () => {
    TOTAL = 75;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'agent_transcript') {
        const options = args as {window?: Parameters<typeof host>[0]; allowLargeHistory?: boolean};
        expect(options.allowLargeHistory).toBe(true);
        return {...host(options.window), agent: 'codex'};
      }
      if (command === 'agent_watch_start') throw new Error('no channel');
      throw new Error(`Unexpected ${command}`);
    });
    render(<ChatPanel sessionId="host" bound={{agent: 'codex', path: '/host/session.jsonl'}} />);
    await screen.findByText('message 74');
    expect(screen.getByRole('button', {name: 'Jump to start'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Load earlier messages'}));
    await screen.findByText('message 0');
    expect(screen.getByText('Start of the session')).toBeTruthy();
    expect(screen.queryByRole('button', {name: 'Load earlier messages'})).toBeNull();
  });

  it('shows what the agent said during a long tool-heavy turn, and its prompt once the pages reach it', async () => {
    TOTAL = 200;
    const pages = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const page = await pages(command, args) as ReturnType<typeof host>;
      return command === 'agent_transcript' ? {...page, messages: page.messages.map(row => work(Number(row.id.slice(1))))} : page;
    });
    render(<ChatPanel sessionId="host" timeline bound={{agent: 'claude', path: '/host/session.jsonl'}} />);
    await screen.findByText('note 190');
    expect(screen.getAllByRole('region', {name: 'Turn'})).toHaveLength(1);
    expect(shownRows()).toBe(5);
    for (const rows of [10, 15, 20]) {
      fireEvent.click(screen.getByRole('button', {name: 'Load earlier messages'}));
      await waitFor(() => expect(shownRows()).toBe(rows));
    }
    expect(screen.getByRole('article', {name: 'user'}).textContent).toContain('Do the long job');
    expect(screen.getByText('Start of the session')).toBeTruthy();
  });

  describe('when the newest page does not fill the list', () => {
    // The list is 1200 px tall and every message takes 10 px, so a page of 50 leaves it unscrollable.
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {configurable: true, get(this: HTMLElement) {return this.classList.contains('chat-messages') ? 1200 : 0;}});
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {configurable: true, get(this: HTMLElement) {return shownRows(this) * 10;}});
    });
    afterEach(() => {
      const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
      delete prototype.clientHeight; delete prototype.scrollHeight;
    });

    it('reads earlier pages until the list scrolls, and stays at the newest message', async () => {
      TOTAL = 1_000;
      await open();
      await screen.findByText('message 850');
      await waitFor(() => expect((screen.getByRole('button', {name: 'Load earlier messages'}) as HTMLButtonElement).disabled).toBe(false));
      expect(transcriptCalls()).toEqual([undefined, {before: 'm950'}, {before: 'm900'}]);
      expect(articles()).toHaveLength(3 * PAGE);
      expect(screen.getByRole('region', {name: 'Conversation messages'}).scrollTop).toBe(1500);
    });

    it('asks a host that cannot page only once', async () => {
      oldCompanion = true;
      await open();
      await screen.findByText(/Update the host companion/);
      await waitFor(() => expect((screen.getByRole('button', {name: 'Load earlier messages'}) as HTMLButtonElement).disabled).toBe(false));
      expect(transcriptCalls()).toEqual([undefined, {before: `m${TOTAL - PAGE}`}]);
    });
  });

  it('loads earlier pages in place until the first message, and never holds more than the window', async () => {
    TOTAL = 1_000;
    await open();
    expect(articles()).toHaveLength(PAGE);
    expect(screen.queryByText('Start of the session')).toBeNull();
    let reads = 0;
    while (screen.queryByText('Start of the session') === null) {
      fireEvent.click(screen.getByRole('button', {name: 'Load earlier messages'}));
      await waitFor(() => expect(transcriptCalls()).toHaveLength(2 + reads++));
      await waitFor(() => expect((screen.queryByRole('button', {name: 'Load earlier messages'}) as HTMLButtonElement | null)?.disabled ?? false).toBe(false));
      expect(articles().length).toBeLessThanOrEqual(400);
      if (reads > 400) throw new Error('never reached the start');
    }
    expect(screen.getByText('message 0')).toBeTruthy();
    // Each request named the message the window started at, so the page continued exactly where it ended.
    expect(transcriptCalls().slice(1, 3)).toEqual([{before: 'm950'}, {before: 'm900'}]);
    // The window gave up the newest messages to stay within its bounds: Jump to latest reads them back.
    expect(screen.queryByText('message 999')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Jump to latest'}));
    await screen.findByText('message 999');
    expect(transcriptCalls().at(-1)).toBeUndefined();
  }, 60_000);

  it('jumps to the start, reads forward from there, and returns to the newest page', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', {name: 'Jump to start'}));
    await screen.findByText('message 0');
    expect(transcriptCalls().at(-1)).toEqual({fromStart: true});
    expect(screen.getByText('Start of the session')).toBeTruthy();
    expect(screen.queryByText('message 11999')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Load later messages'}));
    await screen.findByText('message 99');
    expect(transcriptCalls().at(-1)).toEqual({after: 'm49'});
    expect(articles()).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', {name: 'Jump to latest'}));
    await screen.findByText('message 11999');
    expect(screen.queryByText('Load later messages')).toBeNull();
  });

  it('keeps what is loaded and asks for a companion update when the host cannot page', async () => {
    await open();
    oldCompanion = true;
    fireEvent.click(screen.getByRole('button', {name: 'Load earlier messages'}));
    expect((await screen.findByRole('alert')).textContent).toContain('Update the host companion');
    expect(articles()).toHaveLength(PAGE);
    expect(screen.getByText('message 11999')).toBeTruthy();
  });
});
