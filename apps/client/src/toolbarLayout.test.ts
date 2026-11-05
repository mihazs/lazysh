import {describe, expect, it} from "vitest";
import {placeToolbarKey, removeToolbarKey, resizeToolbarRows, toolbarStepSlot, visibleToolbarRows} from "./toolbarLayout";
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
  it("collapses empty terminal rows but keeps one row for the trailing actions", () => {
    expect(visibleToolbarRows([["esc"], [], ["attach"]], key => key !== "attach")).toEqual([["esc"]]);
    expect(visibleToolbarRows([[], []])).toEqual([[]]);
  });
});
