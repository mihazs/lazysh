import {expect, it} from 'vitest';
import {lightExtendedAnsi} from './terminalPalette';

it('contains exactly the extended slots with the recovered bright-cube and reversed-gray landmarks', () => {
  const palette = lightExtendedAnsi();
  expect(palette).toHaveLength(240);
  expect(palette.every(color => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
  for (const [index, color] of [[16,'#000000'],[21,'#0000ff'],[196,'#ff0000'],[226,'#999900'],[231,'#999999'],[118,'#87ff00'],[154,'#699900'],[232,'#eeeeee'],[237,'#bcbcbc'],[250,'#3a3a3a'],[255,'#080808']] as const) {
    expect(palette[index - 16], `ANSI ${index}`).toBe(color);
  }
  expect(new Set(palette.slice(216)).size).toBe(24);
});

it('does not share mutable palette options between terminals', () => {
  const palette = lightExtendedAnsi();
  palette[0] = '#ffffff';
  palette.length = 1;
  expect(lightExtendedAnsi()).toHaveLength(240);
  expect(lightExtendedAnsi()[0]).toBe('#000000');
});
