import {describe, expect, it} from "vitest";
import {placeToolbarKey, removeToolbarKey, resizeToolbarRows, toolbarCells, toolbarColumns, toolbarStepSlot, visibleToolbarRows} from "./toolbarLayout";
import type {ToolbarKey} from "./preferences";

const rows: ToolbarKey[][] = [["esc", "ctrl", "tab"], ["left", "right"]];
const step = (key: ToolbarKey, direction: Parameters<typeof toolbarStepSlot>[2]) => {
  const slot = toolbarStepSlot(rows, key, direction);
  return slot && placeToolbarKey(rows, key, slot);
};

describe("toolbar key layout", () => {
  it("moves keys one step earlier or later and crosses row edges", () => {
    expect(step("ctrl", "earlier")).toEqual([["ctrl", "esc", "tab"], ["left", "right"]]);
    expect(step("ctrl", "later")).toEqual([["esc", "tab", "ctrl"], ["left", "right"]]);
    expect(step("tab", "later")).toEqual([["esc", "ctrl"], ["tab", "left", "right"]]);
    expect(step("left", "earlier")).toEqual([["esc", "ctrl", "tab", "left"], ["right"]]);
    expect(step("esc", "earlier")).toBeUndefined();
    expect(step("right", "later")).toBeUndefined();
  });
  it("moves keys between rows at the nearest position", () => {
    expect(step("tab", "down")).toEqual([["esc", "ctrl"], ["left", "right", "tab"]]);
    expect(step("left", "up")).toEqual([["left", "esc", "ctrl", "tab"], ["right"]]);
    expect(step("esc", "up")).toBeUndefined();
    expect(step("right", "down")).toBeUndefined();
  });
  it("places a dragged key into any row and adds keys that were not configured", () => {
    expect(placeToolbarKey(rows, "esc", {row: 1, index: 1})).toEqual([["ctrl", "tab"], ["left", "esc", "right"]]);
    expect(placeToolbarKey(rows, "F1", {row: 0, index: 99})).toEqual([["esc", "ctrl", "tab", "F1"], ["left", "right"]]);
    expect(removeToolbarKey(rows, "ctrl")).toEqual([["esc", "tab"], ["left", "right"]]);
    expect(rows).toEqual([["esc", "ctrl", "tab"], ["left", "right"]]);
  });
  it("keeps every key when the row count shrinks", () => {
    expect(resizeToolbarRows([["esc"], ["tab"], ["c"]], 1)).toEqual([["esc", "tab", "c"]]);
    expect(resizeToolbarRows([["esc"]], 3)).toEqual([["esc"], [], []]);
    expect(resizeToolbarRows([["esc"]], 9)).toHaveLength(3);
  });
  it("draws Arrows as an inverted T spanning its row and the row below, Up between its neighbours", () => {
    // The default layout: Up between Home and End, Left, Down and Right under Home, Up and End.
    expect(toolbarCells([["F1", "F2", "F3", "F4", "F5", "F6", "Home", "arrows", "End"], ["F7", "F8", "F9", "F10", "F11", "F12"]])).toEqual([
      ["F1", "F2", "F3", "F4", "F5", "F6", "Home", "up", "End"], ["F7", "F8", "F9", "F10", "F11", "F12", "left", "down", "right"]]);
    // A key after the cluster's column in the row below moves right of it; nothing is dropped.
    expect(toolbarCells([["tab", "Home", "arrows", "End"], ["shift", "ctrl", "enter"]]))
      .toEqual([["tab", "Home", "up", "End"], ["shift", "left", "down", "right", "ctrl", "enter"]]);
    // A shorter row below is padded with gaps so Down stays under Up.
    expect(toolbarCells([["esc", "tab", "Home", "arrows", "End"], ["shift"]]))
      .toEqual([["esc", "tab", "Home", "up", "End"], ["shift", "gap", "left", "down", "right"]]);
    // A longer row below keeps its keys: the cluster is inserted and the rest shifts right.
    expect(toolbarCells([["Home", "arrows", "End"], ["F1", "F2", "F3"]])).toEqual([["Home", "up", "End"], ["left", "down", "right", "F1", "F2", "F3"]]);
  });
  it("starts the cluster with a gap when Arrows is the first key of its row, so Left keeps a column", () => {
    expect(toolbarCells([["arrows", "esc"], ["tab"]])).toEqual([["gap", "up", "esc"], ["left", "down", "right", "tab"]]);
  });
  it("draws Arrows in the last row as Left, Down and Right with Up above Down", () => {
    expect(toolbarCells([["esc", "Home", "End"], ["shift", "arrows"]])).toEqual([["esc", "Home", "up", "End"], ["shift", "left", "down", "right"]]);
    expect(toolbarCells([["esc"], ["shift", "ctrl", "arrows"]])).toEqual([["esc", "gap", "gap", "up"], ["shift", "ctrl", "left", "down", "right"]]);
    // In the middle row it spans the row below, not the one above.
    expect(toolbarCells([["esc"], ["arrows"], ["tab"]])).toEqual([["esc"], ["gap", "up"], ["left", "down", "right", "tab"]]);
  });
  it("puts the four arrows in a line on a toolbar of one row, and leaves layouts without Arrows alone", () => {
    expect(toolbarCells([["esc", "arrows", "tab"]])).toEqual([["esc", "left", "up", "down", "right", "tab"]]);
    expect(toolbarCells([["esc", "left", "up"], ["down", "right"]])).toEqual([["esc", "left", "up"], ["down", "right"]]);
  });
  it("does not draw separate arrow keys twice when the layout also has Arrows", () => {
    expect(toolbarCells([["Home", "up", "arrows", "End"], ["left", "tab"]])).toEqual([["Home", "up", "End"], ["left", "down", "right", "tab"]]);
  });
  it("gives every row the width of the longest one", () => {
    expect(toolbarColumns([["esc", "tab", "up"], ["shift", "gap", "left"], ["tab"]])).toBe(3);
    expect(toolbarColumns([[]])).toBe(1);
  });
  it("collapses empty terminal rows but keeps one row for the trailing actions", () => {
    expect(visibleToolbarRows([["esc"], [], ["attach"]], key => key !== "attach")).toEqual([["esc"]]);
    expect(visibleToolbarRows([[], []])).toEqual([[]]);
    // The cluster is drawn after hidden keys are removed, so it stays aligned with its neighbours and fills a row that was empty.
    expect(visibleToolbarRows([["esc", "attach", "arrows"], []], key => key !== "attach")).toEqual([["esc", "up"], ["left", "down", "right"]]);
  });
});
