import {maxToolbarRows, type ToolbarKey} from "./preferences";

/** Editable rows of toolbar keys; each key appears at most once across all rows. */
export type ToolbarRows = readonly (readonly ToolbarKey[])[];
export type ToolbarSlot = {row: number; index: number};
export type ToolbarStep = "earlier" | "later" | "up" | "down";

export function findToolbarKey(rows: ToolbarRows, key: ToolbarKey): ToolbarSlot | undefined {
  for (let row = 0; row < rows.length; row++) {
    const index = rows[row].indexOf(key);
    if (index >= 0) return {row, index};
  }
}

export function removeToolbarKey(rows: ToolbarRows, key: ToolbarKey): ToolbarKey[][] {
  return rows.map(row => row.filter(item => item !== key));
}

/** Insert `key` at `slot`, removing it from its previous position; `slot.index` counts the row without `key`. */
export function placeToolbarKey(rows: ToolbarRows, key: ToolbarKey, slot: ToolbarSlot): ToolbarKey[][] {
  const next = removeToolbarKey(rows, key);
  const row = Math.min(Math.max(slot.row, 0), next.length - 1);
  next[row].splice(Math.min(Math.max(slot.index, 0), next[row].length), 0, key);
  return next;
}

/** The slot one keyboard step away, crossing into adjacent rows at row edges; undefined when the key cannot move. */
export function toolbarStepSlot(rows: ToolbarRows, key: ToolbarKey, step: ToolbarStep): ToolbarSlot | undefined {
  const at = findToolbarKey(rows, key);
  if (!at) return;
  const {row, index} = at;
  const length = rows[row].length;
  if (step === "earlier") return index > 0 ? {row, index: index - 1} : row > 0 ? {row: row - 1, index: rows[row - 1].length} : undefined;
  if (step === "later") return index < length - 1 ? {row, index: index + 1} : row < rows.length - 1 ? {row: row + 1, index: 0} : undefined;
  const target = step === "up" ? row - 1 : row + 1;
  return target >= 0 && target < rows.length ? {row: target, index: Math.min(index, rows[target].length)} : undefined;
}

/** Change the row count, keeping every key: removed rows join the end of the last remaining row. */
export function resizeToolbarRows(rows: ToolbarRows, count: number): ToolbarKey[][] {
  const size = Math.min(Math.max(Math.trunc(count), 1), maxToolbarRows);
  const next = rows.slice(0, size).map(row => [...row]);
  while (next.length < size) next.push([]);
  next[size - 1].push(...rows.slice(size).flat());
  return next;
}

/** Rows the terminal shows: empty rows collapse, and at least one row remains for the trailing actions. */
export function visibleToolbarRows(rows: ToolbarRows, include: (key: ToolbarKey) => boolean = () => true): ToolbarKey[][] {
  const visible = rows.map(row => row.filter(include)).filter(row => row.length > 0);
  return visible.length ? visible : [[]];
}
