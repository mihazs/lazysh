// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {clampFloat, defaultFloat, loadFloat, saveFloat} from './composerFloat';

afterEach(() => localStorage.clear());
const area = {width: 390, height: 500}, panel = {width: 374, height: 160};

it('keeps the whole panel inside the area, whatever was saved', () => {
  expect(clampFloat({left: -40, bottom: -9}, area, panel)).toEqual({left: 0, bottom: 0});
  expect(clampFloat({left: 900, bottom: 900}, area, panel)).toEqual({left: 16, bottom: 340});
  // A panel larger than the area (a keyboard-sized window) pins to the start edge.
  expect(clampFloat({left: 50, bottom: 50}, {width: 300, height: 100}, panel)).toEqual({left: 0, bottom: 0});
});
it('starts centred above the bottom edge', () => {
  expect(defaultFloat(area, panel)).toEqual({left: 8, bottom: 8});
  expect(defaultFloat({width: 1000, height: 600}, {width: 420, height: 160})).toEqual({left: 290, bottom: 8});
});
it('starts at the top when the bottom would cover the cursor row', () => {
  expect(defaultFloat(area, panel, {top: 460, bottom: 480})).toEqual({left: 8, bottom: 332});
  // A cursor above the panel's band, or none known, leaves it at the bottom.
  expect(defaultFloat(area, panel, {top: 0, bottom: 20})).toEqual({left: 8, bottom: 8});
  expect(defaultFloat(area, panel, null)).toEqual({left: 8, bottom: 8});
});
it('remembers a place on this device and refuses anything else', () => {
  expect(loadFloat()).toBeNull();
  saveFloat({left: 12, bottom: 30});
  expect(loadFloat()).toEqual({left: 12, bottom: 30});
  for (const stored of ['nope', '{"left":"1","bottom":2}', '{"left":1}', '{"left":1e9,"bottom":2}', 'null']) {
    localStorage.setItem('lazysh.composerFloat.v1', stored);
    expect(loadFloat()).toBeNull();
  }
});
