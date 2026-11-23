// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHeadlessCore} from './xterm/nativeCoreHeadless';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {TOUCH_SELECTION_DELAY} from './terminalTouchSelection';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

/** A 20x5 core over a 200x50 anchor: one cell is 10x10 pixels. The core has no queries, so the window of rows answers. */
async function mounted(output = 'hello world\r\nsecond line here') {
  const core = createHeadlessCore({columns: 20, rows: 5, feed: true});
  const element = document.createElement('div');
  element.id = 'pointer-anchor';
  element.getBoundingClientRect = () => ({left: 0, top: 0, width: 200, height: 50, right: 200, bottom: 50, x: 0, y: 0, toJSON() {}});
  document.body.append(element);
  const adapter = await openNativeTerminalAdapter(core);
  await adapter.write!(new TextEncoder().encode(output));
  await adapter.attach({kind: 'native', anchorId: element.id});
  const fire = (type: string, x: number, y: number, init: {detail?: number; shiftKey?: boolean; pointerType?: string} = {}) => {
    const event = new MouseEvent(type, {clientX: x, clientY: y, detail: init.detail ?? 1, shiftKey: init.shiftKey, button: 0, bubbles: true, cancelable: true});
    Object.defineProperty(event, 'pointerType', {value: init.pointerType ?? 'mouse'});
    element.dispatchEvent(event);
    return event;
  };
  return {adapter, fire, core};
}
const at = (column: number, row: number) => [column * 10 + 5, row * 10 + 5] as const;

describe('pointer selection on the native adapter anchor', () => {
  it('selects what a mouse drag covers, in either direction, and clears on a plain click', async () => {
    const {adapter, fire} = await mounted();
    fire('pointerdown', ...at(2, 0)); fire('pointermove', ...at(8, 0)); fire('pointerup', ...at(8, 0));
    expect(adapter.selectionRange()).toEqual({start: {x: 2, y: 0}, end: {x: 8, y: 0}});
    expect(adapter.selectedText()).toBe('llo wor');
    fire('pointerdown', ...at(6, 1)); fire('pointermove', ...at(2, 0)); fire('pointerup', ...at(2, 0));
    expect(adapter.selectionRange()).toEqual({start: {x: 2, y: 0}, end: {x: 6, y: 1}});
    fire('pointerdown', ...at(1, 1)); fire('pointerup', ...at(1, 1));
    expect(adapter.hasSelection()).toBe(false);
  });

  it('takes the word on a double click and the row on a triple click', async () => {
    const {adapter, fire} = await mounted();
    fire('pointerdown', ...at(8, 0), {detail: 2});
    expect(adapter.selectedText()).toBe('world');
    fire('pointerdown', ...at(8, 1), {detail: 3});
    expect(adapter.selectionRange()).toEqual({start: {x: 0, y: 1}, end: {x: 19, y: 1}});
    expect(adapter.selectedText().trimEnd()).toBe('second line here');
  });

  it('extends the selection from its far end on shift-click', async () => {
    const {adapter, fire} = await mounted();
    fire('pointerdown', ...at(2, 0), {detail: 2});
    expect(adapter.selectionRange()).toEqual({start: {x: 0, y: 0}, end: {x: 4, y: 0}});
    fire('pointerdown', ...at(8, 1), {shiftKey: true});
    expect(adapter.selectionRange()).toEqual({start: {x: 0, y: 0}, end: {x: 8, y: 1}});
    fire('pointerdown', ...at(8, 0), {detail: 2});
    fire('pointerdown', ...at(2, 0), {shiftKey: true});
    expect(adapter.selectionRange()).toEqual({start: {x: 2, y: 0}, end: {x: 10, y: 0}});
  });

  it('leaves the mouse to a program that tracks it, and to other buttons', async () => {
    const {adapter, fire} = await mounted('\x1b[?1000h');
    fire('pointerdown', ...at(1, 0)); fire('pointermove', ...at(5, 0));
    expect(adapter.hasSelection()).toBe(false);
    expect(adapter.modes().mouseTracking).not.toBe('none');
  });

  it('selects the word under a still finger held and lifted, extends it on a second hold and drops it on a tap', async () => {
    const {adapter, fire} = await mounted();
    vi.useFakeTimers();
    const hold = (column: number) => { fire('pointerdown', ...at(column, 0), {pointerType: 'touch'}); vi.advanceTimersByTime(TOUCH_SELECTION_DELAY); fire('pointerup', ...at(column, 0), {pointerType: 'touch'}); };
    hold(2);
    expect(adapter.selectionRange()).toEqual({start: {x: 0, y: 0}, end: {x: 4, y: 0}});
    hold(8);
    expect(adapter.selectionRange()).toEqual({start: {x: 0, y: 0}, end: {x: 10, y: 0}});
    fire('pointerdown', ...at(3, 1), {pointerType: 'touch'}); fire('pointerup', ...at(3, 1), {pointerType: 'touch'});
    expect(adapter.hasSelection()).toBe(false);
  });

  it('does not select when the finger moves (a scroll) or lifts early, and stops after detach', async () => {
    const {adapter, fire} = await mounted();
    vi.useFakeTimers();
    fire('pointerdown', ...at(2, 0), {pointerType: 'touch'}); fire('pointermove', ...at(2, 3), {pointerType: 'touch'});
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAY); fire('pointerup', ...at(2, 3), {pointerType: 'touch'});
    fire('pointerdown', ...at(2, 0), {pointerType: 'touch'}); fire('pointerup', ...at(2, 0), {pointerType: 'touch'});
    expect(adapter.hasSelection()).toBe(false);
    await adapter.detach();
    fire('pointerdown', ...at(8, 0), {detail: 2});
    expect(adapter.hasSelection()).toBe(false);
  });
});

describe('mouse reports to a program that tracks the mouse', () => {
  const sent = (core: Awaited<ReturnType<typeof mounted>>['core']) => core.mice.map(m => [m.action, m.button, m.x, m.y]);
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));

  it('sends a mouse its press, drag motion and release in the cell under it, and selects nothing', async () => {
    const {adapter, fire, core} = await mounted('\x1b[?1002h');
    fire('pointerdown', ...at(2, 1)); fire('pointermove', ...at(5, 1)); fire('pointerup', ...at(5, 1));
    await settle();
    expect(sent(core)).toEqual([['press', 'left', 2, 1], ['motion', 'left', 5, 1], ['release', 'left', 5, 1]]);
    expect(adapter.hasSelection()).toBe(false);
  });

  it('reports no motion at the plain click level', async () => {
    const {fire, core} = await mounted('\x1b[?1000h');
    fire('pointerdown', ...at(1, 0)); fire('pointermove', ...at(4, 0)); fire('pointerup', ...at(4, 0));
    await settle();
    expect(sent(core).map(r => r[0])).toEqual(['press', 'release']);
  });

  it('sends a quick still tap of a finger as a click, and a finger that scrolled as nothing', async () => {
    const {fire, core} = await mounted('\x1b[?1000h');
    fire('pointerdown', ...at(3, 2), {pointerType: 'touch'}); fire('pointerup', ...at(3, 2), {pointerType: 'touch'});
    fire('pointerdown', ...at(3, 0), {pointerType: 'touch'}); fire('pointermove', ...at(3, 3), {pointerType: 'touch'}); fire('pointerup', ...at(3, 3), {pointerType: 'touch'});
    await settle();
    expect(sent(core)).toEqual([['press', 'left', 3, 2], ['release', 'left', 3, 2]]);
  });

  it('sends nothing while the program does not track the mouse', async () => {
    const {fire, core} = await mounted();
    fire('pointerdown', ...at(1, 0)); fire('pointerup', ...at(1, 0));
    await settle();
    expect(core.mice).toEqual([]);
  });
});
