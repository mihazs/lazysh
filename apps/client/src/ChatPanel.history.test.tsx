// @vitest-environment jsdom
import {invoke} from '@tauri-apps/api/core';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
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

/** The reader scrolled up from the newest message: jsdom has no layout, so the list reports a distance. */
const scrollAway = () => {
  const list = screen.getByRole('region', {name: 'Conversation messages'});
  for (const [key, value] of Object.entries({scrollHeight: 5000, clientHeight: 500, scrollTop: 100})) Object.defineProperty(list, key, {configurable: true, get: () => value, set: () => {}});
  fireEvent.scroll(list);
};
const open = async () => {
  render(<ChatPanel sessionId="host" bound={{agent: 'claude', path: '/host/session.jsonl'}} />);
  await screen.findByText(`message ${TOTAL - 1}`);
};

describe('reading a 12k message session from the Agent view', () => {
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
    expect(screen.queryByRole('button', {name: 'Jump to start'})).toBeNull();
    scrollAway();
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

/** An IntersectionObserver whose sentinels are in range of the list as the test says, and that reports as the browser does: on observe. */
const reading = {top: false, bottom: false};
const observers: {options: IntersectionObserverInit}[] = [];
class FakeObserver {
  private live = true;
  constructor(private callback: (entries: {isIntersecting: boolean}[]) => void, options: IntersectionObserverInit) {observers.push({options});}
  observe(node: HTMLElement) {queueMicrotask(() => this.live && this.callback([{isIntersecting: node.dataset.edge === 'top' ? reading.top : reading.bottom}]));}
  disconnect() {this.live = false;}
}
const earlier = () => screen.getByRole('group', {name: 'Earlier messages'});

describe('reading on by scrolling, without a tap', () => {
  let inFlight: number, peak: number;
  beforeEach(() => {
    reading.top = reading.bottom = false; observers.length = 0; inFlight = peak = 0; TOTAL = 1_000;
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const serve = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      peak = Math.max(peak, ++inFlight);
      try {await Promise.resolve(); return await serve(command, args);} finally {inFlight--;}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads earlier pages while the top is in range until the first message, one at a time and within the window', async () => {
    await open();
    reading.top = true;
    // Entering the margin starts the read: the sentinel is only reported once something re-arms it.
    fireEvent.click(within(earlier()).getByRole('button', {name: 'Load earlier messages'}));
    await screen.findByText('Start of the session', {}, {timeout: 20_000});
    expect(screen.getByText('message 0')).toBeTruthy();
    expect(peak).toBe(1);
    expect(articles().length).toBeLessThanOrEqual(400);
    expect(transcriptCalls().slice(1, 3)).toEqual([{before: 'm950'}, {before: 'm900'}]);
    // The prefetch margin is a screen and a half of the list, so a page lands before its edge is reached.
    expect(observers.every(({options}) => options.rootMargin === '150% 0px')).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  }, 60_000);

  it('reads later pages while the bottom is in range until the end, and says where the session ends', async () => {
    await open();
    scrollAway();
    fireEvent.click(screen.getByRole('button', {name: 'Jump to start'}));
    await screen.findByText('Start of the session');
    expect(screen.queryByText('End of the session so far')).toBeNull();
    reading.bottom = true;
    fireEvent.click(screen.getByRole('button', {name: 'Load later messages'}));
    await screen.findByText('End of the session so far', {}, {timeout: 20_000});
    expect(screen.getByText('message 999')).toBeTruthy();
    expect(peak).toBe(1);
    expect(articles().length).toBeLessThanOrEqual(400);
    // The first message was released on the way: reading back up is possible.
    expect(within(earlier()).getByRole('button', {name: 'Load earlier messages'})).toBeTruthy();
  }, 60_000);

  it('stops at a failed page with a Retry row instead of trying again, and Retry reads it', async () => {
    await open();
    const serve = vi.mocked(invoke).getMockImplementation()!;
    let failures = 1;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if ((args as {window?: unknown}).window && failures-- > 0) throw new Error('connection reset');
      return serve(command, args);
    });
    reading.top = true;
    fireEvent.click(within(earlier()).getByRole('button', {name: 'Load earlier messages'}));
    expect((await screen.findByRole('alert')).textContent).toContain('connection reset');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(transcriptCalls()).toHaveLength(2);
    expect(articles()).toHaveLength(PAGE);
    fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
    await screen.findByText('message 900');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops at a page that adds nothing instead of asking the host for it again and again', async () => {
    await open();
    const serve = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => (args as {window?: unknown}).window ? {...host(), messages: [], truncated: true} : serve(command, args));
    reading.top = true;
    fireEvent.click(within(earlier()).getByRole('button', {name: 'Load earlier messages'}));
    await screen.findByText('Start of the session');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(transcriptCalls()).toHaveLength(2);
  });

  it('waits while text in the list is selected and resumes when the selection is gone', async () => {
    await open();
    const selection = vi.spyOn(document, 'getSelection');
    selection.mockReturnValue({isCollapsed: false, anchorNode: screen.getByText('message 999')} as unknown as Selection);
    document.dispatchEvent(new Event('selectionchange'));
    reading.top = true;
    await waitFor(() => expect(within(earlier()).getByRole('button', {name: 'Load earlier messages'})).toBeTruthy());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(transcriptCalls()).toHaveLength(1);
    selection.mockReturnValue({isCollapsed: true, anchorNode: null} as unknown as Selection);
    document.dispatchEvent(new Event('selectionchange'));
    await screen.findByText('message 900');
    selection.mockRestore();
  });
});
