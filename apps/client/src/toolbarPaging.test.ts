import {describe, expect, it} from "vitest";
import {nearestPage, OVERSCROLL_DISTANCE, pageEdges, touchOverscroll, wheelOverscroll} from "./toolbarPaging";

const middle = {atStart: false, atEnd: false}, end = {atStart: false, atEnd: true}, start = {atStart: true, atEnd: false};

describe("toolbar paging", () => {
  it("reads page edges and the nearest snapped page", () => {
    expect(pageEdges({scrollTop: 0, clientHeight: 100, scrollHeight: 100})).toEqual({atStart: true, atEnd: true});
    expect(pageEdges({scrollTop: 39.5, clientHeight: 100, scrollHeight: 140})).toEqual({atStart: false, atEnd: true});
    expect(pageEdges({scrollTop: 20, clientHeight: 100, scrollHeight: 140})).toEqual(middle);
    expect(nearestPage([0, 365, 730], 200)).toBe(1);
    expect(nearestPage([0, 365, 730], 100)).toBe(0);
  });

  it("turns the page only after the drag continues past the last row", () => {
    const drag = touchOverscroll(100, 200);
    // Scrolling the rows themselves never pages.
    expect(drag(100, 180, middle)).toBe(0);
    expect(drag(100, 170, end)).toBe(0);
    expect(drag(100, 170 - OVERSCROLL_DISTANCE + 1, end)).toBe(0);
    expect(drag(100, 170 - OVERSCROLL_DISTANCE, end)).toBe(1);
    // One drag turns one page.
    expect(drag(100, 0, end)).toBe(0);
  });

  it("starts over when the drag turns back or becomes sideways", () => {
    const back = touchOverscroll(100, 200);
    expect(back(100, 190, end)).toBe(0);
    expect(back(100, 160, end)).toBe(0);
    expect(back(100, 170, end)).toBe(0);
    expect(back(100, 140, end)).toBe(0);
    expect(back(100, 140 - OVERSCROLL_DISTANCE, end)).toBe(1);
    const sideways = touchOverscroll(100, 200);
    expect(sideways(100, 190, start)).toBe(0);
    expect(sideways(400, 300, start)).toBe(0);
    const previous = touchOverscroll(100, 100);
    expect(previous(100, 110, start)).toBe(0);
    expect(previous(100, 110 + OVERSCROLL_DISTANCE, start)).toBe(-1);
  });

  it("pages a wheel at an edge once per cooldown, and resets after a pause or a reversal", () => {
    const wheel = wheelOverscroll();
    expect(wheel(0, 100, middle, 0)).toBe(0);
    expect(wheel(0, 60, end, 10)).toBe(0);
    expect(wheel(0, 60, end, 20)).toBe(1);
    // Trackpad momentum right after paging does not skip another page.
    expect(wheel(0, 120, end, 200)).toBe(0);
    expect(wheel(0, 60, end, 1000)).toBe(0);
    expect(wheel(0, 60, end, 1400)).toBe(0);
    expect(wheel(0, -60, start, 1410)).toBe(0);
    expect(wheel(0, -60, start, 1420)).toBe(-1);
    expect(wheel(120, 30, end, 3000)).toBe(0);
  });
});
