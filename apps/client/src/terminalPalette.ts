// Generated once; callers receive a copy so options consumers cannot alter
// another terminal's palette. See docs/themes.md for the pinned static evidence.
const levels = [0, 95, 135, 175, 215, 255];
const hex = (channels: number[]) => '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');
const lightPalette: string[] = [];
for (const r of levels) for (const g of levels) for (const b of levels) {
  const scale = .299 * r + .587 * g + .114 * b > 200 ? .6 : 1;
  lightPalette.push(hex([r, g, b].map(c => Math.floor(c * scale + .5))));
}
for (let i = 0; i < 24; i++) lightPalette.push(hex(Array(3).fill(Math.max(8, Math.min(238, 238 - 10 * i)))));

export function lightExtendedAnsi(): string[] { return lightPalette.slice(); }
