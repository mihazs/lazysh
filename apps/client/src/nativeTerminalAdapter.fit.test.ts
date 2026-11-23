// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHeadlessCore} from './xterm/nativeCoreHeadless';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {defaults, terminalPreferences} from './preferences';
import type {TerminalEvent, TerminalPreferences} from './terminalAdapter';
import type {CellSize} from './terminalSurfaceAnchor';

/** The renderer's cell: 0.6 x 1.2 of the font size in device pixels, whole pixels, as `Look::appearance` makes it (to within its rounding). */
const cellFor = (fontSize: number, dpr: number): CellSize => ({width: Math.round(fontSize * 0.6 * dpr), height: Math.round(fontSize * 1.2 * dpr)});

let anchors = 0;
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

/** A native pane of `width` x `height` CSS pixels that a test can resize, as the layout does. */
async function open(surface: string | null = 's1') {
  const core = createHeadlessCore();
  const cell = vi.fn(async (fontSize: number, dpr: number) => cellFor(fontSize, dpr));
  const adapter = await openNativeTerminalAdapter(core, {look: async () => {}, cell});
  const element = document.createElement('div');
  element.id = `fit-anchor-${anchors++}`;
  document.body.append(element);
  const pane = {left: 10, top: 20, width: 480, height: 240};
  element.getBoundingClientRect = () => ({...pane, x: pane.left, y: pane.top, right: pane.left + pane.width, bottom: pane.top + pane.height, toJSON: () => ({})});
  await adapter.attach({kind: 'native', anchorId: element.id, surface: surface ?? undefined});
  const preferences: TerminalPreferences = {...terminalPreferences(defaults), fontSize: 10};
  const intents: {columns: number; rows: number}[] = [];
  adapter.subscribe(event => { if (event.type === 'resizeIntent') intents.push(event.size); }, ['resizeIntent'] as const satisfies readonly TerminalEvent['type'][]);
  return {core, adapter, cell, pane, preferences, intents};
}
/** The grid the core holds, once the adapter's commands have reached it. */
const coreGrid = (core: ReturnType<typeof createHeadlessCore>, expected: {columns: number; rows: number}) => vi.waitFor(async () => {
  const {state} = await core.snapshot();
  expect({columns: state.columns, rows: state.rows}).toEqual(expected);
});

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('the grid of a native terminal follows its pane', () => {
  it('is the whole cells of the renderer that the pane holds, in the adapter and in the core, and again after every change of the pane', async () => {
    const {core, adapter, pane, preferences, intents} = await open();
    const start = adapter.size();
    expect(adapter.proposeSize()).toBeUndefined();
    adapter.fit();
    expect(adapter.size(), 'nothing is known about the cell yet').toEqual(start);

    // 10 px text is a 6 x 12 pixel cell: 480 x 240 holds 80 x 20.
    adapter.applyPreferences(preferences);
    await vi.waitFor(() => expect(adapter.size()).toEqual({columns: 80, rows: 20}));
    await coreGrid(core, {columns: 80, rows: 20});
    expect(adapter.proposeSize()).toEqual({columns: 80, rows: 20});
    expect(intents).toEqual([{columns: 80, rows: 20}]);

    // A rotation: the pane's other shape. The ResizeObserver of the page asks for a fit; so does nothing else.
    Object.assign(pane, {width: 245, height: 481});
    adapter.fit();
    expect(adapter.size(), 'a partial cell is not a cell').toEqual({columns: 40, rows: 40});
    await coreGrid(core, {columns: 40, rows: 40});
    expect(adapter.metrics()).toMatchObject({columns: 40, rows: 40, cellWidth: 6, cellHeight: 12});

    // The same pane: no new intent.
    adapter.fit();
    adapter.fit();
    expect(intents).toEqual([{columns: 80, rows: 20}, {columns: 40, rows: 40}]);

    // A pinch: bigger text, bigger cells, fewer of them, without the pane having changed.
    adapter.applyPreferences({...preferences, fontSize: 20});
    await vi.waitFor(() => expect(adapter.size()).toEqual({columns: 20, rows: 20}));
    await coreGrid(core, {columns: 20, rows: 20});
    expect(adapter.layoutRowHeight()).toBe(24);
  });

  it('is measured at the display density: a denser screen has more pixels to a cell, not more cells', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const {adapter, cell, pane, preferences} = await open();
    adapter.applyPreferences(preferences);
    await vi.waitFor(() => expect(adapter.size()).toEqual({columns: 80, rows: 20}));
    expect(cell).toHaveBeenCalledWith(10, 2);
    // Layout pixels: a cell is half its device pixels.
    expect(adapter.layoutRowHeight()).toBe(12);
    expect(adapter.metrics()).toMatchObject({cellWidth: 6, cellHeight: 12});

    // The page zoomed: the same text on a display of 1 device pixel to a CSS pixel.
    vi.stubGlobal('devicePixelRatio', 1);
    Object.assign(pane, {width: 480, height: 240});
    adapter.fit();
    await vi.waitFor(() => expect(cell).toHaveBeenCalledWith(10, 1));
    await vi.waitFor(() => expect(adapter.size()).toEqual({columns: 80, rows: 20}));
    expect(adapter.layoutRowHeight()).toBe(12);
    // Rounded to the surface's pixels, as the shell makes them: at 2.5, 100.4 CSS pixels are 251 device pixels and 50.2 are 125.5, which is 126.
    vi.stubGlobal('devicePixelRatio', 2.5);
    Object.assign(pane, {width: 100.4, height: 50.2});
    adapter.fit();
    await vi.waitFor(() => expect(adapter.size()).toEqual({columns: 16, rows: 4}));
  });

  it('is asked of the shell once for each font size and density, and a refusal is asked again', async () => {
    const {adapter, cell, preferences} = await open();
    adapter.applyPreferences(preferences);
    adapter.applyPreferences({...preferences, scrollbackLines: 50});
    adapter.fit();
    await vi.waitFor(() => expect(adapter.proposeSize()).toBeDefined());
    adapter.fit();
    expect(cell).toHaveBeenCalledTimes(1);

    cell.mockRejectedValueOnce(new Error('native_surface_disabled'));
    adapter.applyPreferences({...preferences, fontSize: 12});
    await settle();
    expect(adapter.proposeSize()).toBeUndefined();
    adapter.fit();
    await vi.waitFor(() => expect(adapter.proposeSize()).toBeDefined());
    expect(cell).toHaveBeenCalledTimes(3);
  });

  it('has nothing to fit without a renderer surface or a pane with a box', async () => {
    const {adapter, cell, preferences, intents} = await open(null);
    const start = adapter.size();
    adapter.applyPreferences(preferences);
    adapter.fit();
    await settle();
    expect(cell).not.toHaveBeenCalled();
    expect(adapter.proposeSize()).toBeUndefined();
    expect(adapter.layoutRowHeight()).toBe(0);
    expect(adapter.size()).toEqual(start);
    expect(intents).toEqual([]);

    const empty = await open();
    empty.adapter.applyPreferences(empty.preferences);
    await vi.waitFor(() => expect(empty.adapter.size()).toEqual({columns: 80, rows: 20}));
    Object.assign(empty.pane, {width: 3, height: 5});
    empty.adapter.fit();
    expect(empty.adapter.proposeSize()).toBeUndefined();
    expect(empty.adapter.size(), 'a pane too small for one cell keeps its grid').toEqual({columns: 80, rows: 20});
  });

  it('puts a touch on the cell that is drawn under it, margins and all', async () => {
    const {adapter, preferences, pane} = await open();
    adapter.applyPreferences(preferences);
    await vi.waitFor(() => expect(adapter.size()).toEqual({columns: 80, rows: 20}));
    // The pane starts at (10, 20); a cell is 6 x 12.
    expect(adapter.cellAt(10 + 5, 20 + 11)).toEqual({x: 0, y: 0});
    expect(adapter.cellAt(10 + 6, 20 + 12)).toEqual({x: 1, y: 1});
    expect(adapter.cellAt(10 + 479, 20 + 239)).toEqual({x: 79, y: 19});
    // A pane that is 5 pixels wider than its 80 cells: the margin is no cell, so the grid is not stretched over it.
    Object.assign(pane, {width: 485});
    adapter.fit();
    expect(adapter.size().columns).toBe(80);
    expect(adapter.cellAt(10 + 6 * 79, 20)).toEqual({x: 79, y: 0});
    expect(adapter.cellAt(10 + 483, 20)).toEqual({x: 79, y: 0});
  });
});
