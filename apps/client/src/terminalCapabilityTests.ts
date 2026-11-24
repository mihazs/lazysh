/**
 * Which tests stand behind each capability a backend can claim (docs/architecture/terminal-adapter.md). A backend
 * must not claim a capability without a passing test, so a capability with no cases here cannot be claimed, and a case
 * that is renamed, removed or failing takes its capability with it. `terminalBackends.contract.test.ts` holds every
 * registered backend to this table after running the suites below.
 */
import {describe, expect, it, onTestFinished, vi, type RunnerTestSuite} from 'vitest';
import {defaults, terminalPreferences} from './preferences';
import type {TerminalCapabilities, TerminalPreferences} from './terminalAdapter';
import type {ContractHarness} from './terminalAdapter.contract';
import {nativeSurface} from './terminalSurfaceAnchor';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Titles of the cases in `terminalAdapter.contract.ts` (the first five) and in this file's suite (the last four). */
const cases = {
  scrolls: 'scrolls through history and follows live output again',
  liveScreen: 'knows when the primary screen shows live output',
  followsLive: 'returns a reader of history to the live screen when typed input would',
  searches: 'searches the whole buffer, wrapping, in both directions',
  configured: 'reports where the screen is drawn, the cursor and the configured scrollback',
  mouseLevels: 'reports every mouse tracking level a program can ask for',
  wheel: 'delivers a wheel notch where the pointer is',
  screenReader: 'offers a screen reader one list item per row while that reader is in use',
  boldColor: 'applies the fixed colour to default-coloured bold text',
} as const;

/** The cases that verify each capability. An empty list means no test can observe it yet, so no backend may claim it. */
export const capabilityCases = {
  /** No case observes a renderer: the native backend's own slices add one with the first renderer. */
  nativeRendering: [],
  selection: [
    'selects by absolute inclusive coordinates, wide characters included, and reports the change',
    'answers selection questions without building text, and clears on request',
    'selects across rows by absolute coordinates, ending on the last column',
  ],
  scrollback: [cases.scrolls, cases.liveScreen, cases.followsLive, cases.searches, cases.configured],
  mouseReporting: [cases.mouseLevels, cases.wheel],
  ime: ['shows the UI every key event before the terminal, until released', 'separates typed input, terminal replies and bracketed paste'],
  accessibility: [cases.screenReader],
  screenInspection: ['claims only what it provides', 'applies bytes in order, split anywhere, and acknowledges only after applying them'],
  canonicalMoshResize: [
    'treats a size request as intent and a Mosh frame as the geometry authority',
    'reports a malformed Mosh frame as a failure, not as terminal output',
  ],
  customBoldColor: [cases.boldColor],
} as const satisfies Record<keyof TerminalCapabilities, readonly string[]>;

/** The capabilities `claimed` that are not tested: those with no case, or with a case that is not in `passed`. */
export function untestedCapabilities(claimed: TerminalCapabilities, passed: ReadonlySet<string>) {
  return (Object.keys(capabilityCases) as (keyof TerminalCapabilities)[])
    .filter(name => claimed[name] && (!capabilityCases[name].length || !(capabilityCases[name] as readonly string[]).every(title => passed.has(title))));
}

/** The titles of the cases under `suite` that have run and passed. */
export function passedCases(suite: RunnerTestSuite): Set<string> {
  const passed = new Set<string>();
  const visit = (tasks: RunnerTestSuite['tasks']) => tasks.forEach(task => {
    if (task.type === 'suite') visit(task.tasks); else if (task.result?.state === 'pass') passed.add(task.name);
  });
  visit(suite.tasks);
  return passed;
}

/**
 * The cases for the capabilities `terminalAdapter.contract.ts` has no part for. They observe what a DOM backend
 * draws, and run only for a backend that claims the capability; a backend that draws no DOM fails them until its own
 * case replaces them, which is the point: a claim nothing can observe is not accepted.
 */
export function runTerminalCapabilityContract(name: string, harness: ContractHarness) {
  /** A new adapter, attached, with the element it is drawn into; it is disposed when the test ends. */
  async function open(surface?: string) {
    const adapter = await harness.create();
    onTestFinished(() => adapter.dispose());
    const mountTarget = harness.target();
    const target = mountTarget.kind === 'native' && surface ? {...mountTarget, surface} : mountTarget;
    await adapter.attach(target);
    const mount = target.kind === 'dom' ? target.element : document.getElementById(target.anchorId)!;
    const preferences: TerminalPreferences = terminalPreferences(defaults);
    return {adapter, target, mount, preferences, write: (data: string) => adapter.write!(new TextEncoder().encode(data))};
  }

  describe(`TerminalAdapter capability contract: ${name}`, () => {
    it(cases.mouseLevels, async () => {
      const {adapter, write} = await open();
      if (!adapter.capabilities.mouseReporting) return;
      for (const [mode, level] of [['9', 'x10'], ['1000', 'vt200'], ['1002', 'drag'], ['1003', 'any']] as const) {
        await write(`\x1b[?${mode}h`);
        expect(adapter.modes().mouseTracking, level).toBe(level);
        await write(`\x1b[?${mode}l`);
        expect(adapter.modes().mouseTracking, `${level} reset`).toBe('none');
      }
    });

    it(cases.wheel, async () => {
      const {adapter, mount} = await open();
      if (!adapter.capabilities.mouseReporting) return;
      const seen: WheelEvent[] = [];
      mount.addEventListener('wheel', event => seen.push(event as WheelEvent));
      adapter.wheel({clientX: 3, clientY: 4, deltaY: -2, unit: 'line'});
      expect(seen.map(event => [event.clientX, event.clientY, event.deltaY, event.deltaMode])).toEqual([[3, 4, -2, WheelEvent.DOM_DELTA_LINE]]);
    });

    it(cases.screenReader, async () => {
      const {adapter, mount, preferences} = await open();
      if (!adapter.capabilities.accessibility) return;
      const items = () => mount.querySelectorAll('[role="list"] > [role="listitem"]').length;
      expect(items()).toBe(0);
      adapter.applyPreferences({...preferences, screenReader: true});
      expect(items()).toBe(adapter.size().rows);
      adapter.applyPreferences({...preferences, screenReader: false});
      expect(items()).toBe(0);
      await sleep(30); // the DOM backend re-syncs its scroll area on a timer, which must not outlive the adapter
    });

    it(cases.boldColor, async () => {
      const {adapter, target, mount, preferences, write} = await open('bold-colour');
      expect(adapter.capabilities.customBoldColor).toBe(true);
      if (target.kind === 'native') {
        const look = vi.spyOn(nativeSurface, 'look').mockResolvedValue(undefined);
        onTestFinished(() => { look.mockRestore(); });
        adapter.applyPreferences({...preferences, brightBold: false, boldColor: '#336699'});
        await vi.waitFor(() => expect(look).toHaveBeenLastCalledWith('bold-colour',
          expect.objectContaining({brightBold: false, boldColor: '#336699'})));
        adapter.applyPreferences({...preferences, brightBold: false, boldColor: undefined});
        await vi.waitFor(() => expect(look).toHaveBeenLastCalledWith('bold-colour',
          expect.objectContaining({brightBold: false, boldColor: undefined})));
        return;
      }
      const colourOf = async (text: string) => {
        await write(`\x1b[1m${text}\x1b[0m\r\n`);
        await sleep(30); // the DOM renderer draws on the next animation frame
        const run = [...mount.querySelectorAll('*')].find(element => !element.children.length && element.textContent === text);
        if (!run) throw new Error(`Nothing drawn in the mount shows "${text}".`);
        return getComputedStyle(run).color;
      };
      adapter.applyPreferences({...preferences, brightBold: false, boldColor: '#336699'});
      expect(await colourOf('fixed')).toBe('rgb(51, 102, 153)');
      adapter.applyPreferences({...preferences, brightBold: false, boldColor: undefined});
      expect(await colourOf('plain')).not.toBe('rgb(51, 102, 153)');
    });
  });
}
