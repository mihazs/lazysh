/** Pure command palette model: matching, ranking and keyboard selection. */
export type PaletteGroup = 'host' | 'session' | 'tool' | 'action';
export type PaletteCommand = Readonly<{
  id: string;
  group: PaletteGroup;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  current?: boolean;
  disabled?: boolean;
  reason?: string;
  run: () => void;
}>;

/** Case- and accent-insensitive text, so "sessao" finds "Sessão". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
const boundary = (text: string, index: number) => index === 0 || /[\s@./:_\-·()[\]]/.test(text[index - 1]);

/** Scores a contiguous hit; earlier and word-initial hits rank higher. */
function substringScore(token: string, text: string): number | null {
  const index = text.indexOf(token);
  return index < 0 ? null : 100 - Math.min(index, 50) + (boundary(text, index) ? 40 : 0) + token.length * 2;
}
/** Labels also accept an ordered subsequence ("fls" finds "Files"). */
function tokenScore(token: string, text: string): number | null {
  const contiguous = substringScore(token, text);
  if (contiguous !== null) return contiguous;
  let score = 0, from = 0, previous = -2;
  for (const character of token) {
    const index = text.indexOf(character, from);
    if (index < 0) return null;
    score += (index === previous + 1 ? 3 : 0) + (boundary(text, index) ? 5 : 1);
    previous = index; from = index + 1;
  }
  return score;
}

/** Returns a ranking score when every query token matches the label (fuzzily) or a detail or keyword (contiguously). */
export function paletteScore(command: PaletteCommand, query: string): number | null {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const label = fold(command.label);
  const rest = fold([command.detail ?? '', ...(command.keywords ?? [])].join(' '));
  let total = 0;
  for (const token of tokens) {
    const primary = tokenScore(token, label), secondary = substringScore(token, rest);
    if (primary === null && secondary === null) return null;
    total += Math.max(primary === null ? -Infinity : primary * 2, secondary ?? -Infinity);
  }
  return total + (label.startsWith(tokens[0]) ? 60 : 0);
}

/** Filters commands; an empty query keeps the given order, otherwise the best matches come first. */
export function filterPalette(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  if (!query.trim()) return [...commands];
  return commands
    .map((command, index) => ({command, index, score: paletteScore(command, query)}))
    .filter((row): row is {command: PaletteCommand; index: number; score: number} => row.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(row => row.command);
}

/** The first enabled command, or -1 when none can run. */
export function firstEnabled(commands: readonly PaletteCommand[]): number {
  return commands.findIndex(command => !command.disabled);
}

/** Moves the active option with arrow keys, wrapping and skipping disabled commands. */
export function movePaletteSelection(commands: readonly PaletteCommand[], active: number, key: string): number {
  const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (!step || !commands.length) return active;
  for (let offset = 1; offset <= commands.length; offset++) {
    const index = ((active < 0 && step < 0 ? 0 : active) + step * offset + commands.length * offset) % commands.length;
    if (!commands[index].disabled) return index;
  }
  return active;
}
