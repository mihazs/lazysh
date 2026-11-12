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

/** A drawn toolbar cell: a key, or the empty cell the Arrows cluster leaves beside its Up key. */
export type ToolbarCell = ToolbarKey | "gap";
const arrowKeys: readonly ToolbarKey[] = ["left", "up", "down", "right"];

/** Insert `cells` at column `index` of a row, padding a shorter row with gaps so the columns line up. */
function insertCells(row: ToolbarCell[], index: number, cells: readonly ToolbarCell[]) {
  while (row.length < index) row.push("gap");
  row.splice(index, 0, ...cells);
}

/**
 * Draws the Arrows component as the classic inverted T: Up over Down, Left and Right beside Down. The component is
 * one entry of one row; it spans that row and the row below it, or the row above it when it is in the last row, so
 * moving it in the editor moves the whole cluster. A toolbar of one row has no second row and gets the four keys in
 * a line. The cluster has all four arrows, so separate arrow keys in the same layout are not drawn twice.
 */
export function toolbarCells(rows: ToolbarRows): ToolbarCell[][] {
  if (!findToolbarKey(rows, "arrows")) return rows.map(row => [...row]);
  const cells: ToolbarCell[][] = rows.map(row => row.filter(key => !arrowKeys.includes(key)));
  const {row, index} = findToolbarKey(cells as ToolbarRows, "arrows")!;
  if (cells.length === 1) cells[0].splice(index, 1, "left", "up", "down", "right");
  else if (row < cells.length - 1) {
    // Up takes the entry's cell, after a gap when that is the first column so Left still has a column; Left, Down and Right go below.
    if (index === 0) cells[row].unshift("gap");
    const column = Math.max(index, 1);
    cells[row][column] = "up";
    insertCells(cells[row + 1], column - 1, ["left", "down", "right"]);
  } else {
    cells[row].splice(index, 1, "left", "down", "right");
    insertCells(cells[row - 1], index + 1, ["up"]);
  }
  return cells;
}

/** Rows the terminal shows: the Arrows cluster drawn, empty rows collapsed, and at least one row remains for the trailing actions. */
export function visibleToolbarRows(rows: ToolbarRows, include: (key: ToolbarKey) => boolean = () => true): ToolbarCell[][] {
  const visible = toolbarCells(rows.map(row => row.filter(include))).filter(row => row.length > 0);
  return visible.length ? visible : [[]];
}

/** Columns every row shares, so keys have one width. */
export function toolbarColumns(rows: readonly (readonly ToolbarCell[])[]): number {
  return Math.max(1, ...rows.map(row => row.length));
}
