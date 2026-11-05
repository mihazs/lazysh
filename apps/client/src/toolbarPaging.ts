/** Paging decisions for the terminal toolbar carousel; DOM-free so the thresholds stay testable. */

/** Extra finger travel, in CSS pixels, past a page's last (or first) row before the adjacent page opens. */
export const OVERSCROLL_DISTANCE = 48;
/** Wheel travel past a page edge before paging; one ordinary mouse-wheel notch reaches it. */
export const WHEEL_DISTANCE = 100;
const WHEEL_IDLE = 300;
const WHEEL_COOLDOWN = 450;

/** -1 moves to the previous page, 1 to the next one, 0 stays. */
export type PageStep = -1 | 0 | 1;
export type PageEdges = {atStart: boolean; atEnd: boolean};

export function pageEdges(page: {scrollTop: number; clientHeight: number; scrollHeight: number}): PageEdges {
  return {atStart: page.scrollTop <= 0, atEnd: page.scrollTop + page.clientHeight >= page.scrollHeight - 1};
}

/** The page whose left edge is closest to the current horizontal scroll position. */
export function nearestPage(offsets: readonly number[], scrollLeft: number): number {
  let best = 0;
  offsets.forEach((offset, index) => {if (Math.abs(offset - scrollLeft) < Math.abs(offsets[best] - scrollLeft)) best = index;});
  return best;
}

/**
 * Tracks one vertical touch drag. Scrolling inside the page is left to the browser; once the page
 * has nothing more to show in the drag direction, continuing for OVERSCROLL_DISTANCE pages once.
 */
export function touchOverscroll(x: number, y: number) {
  let lastY = y, anchor: {step: PageStep; y: number} | null = null, done = false;
  return (nextX: number, nextY: number, edges: PageEdges): PageStep => {
    const travel = nextY - lastY;
    lastY = nextY;
    // Horizontal drags belong to the carousel's own scroll snapping.
    if (done || Math.abs(nextY - y) <= Math.abs(nextX - x)) {anchor = null; return 0;}
    const step: PageStep = travel < 0 ? 1 : travel > 0 ? -1 : 0;
    if (!step) return 0;
    if (!(step === 1 ? edges.atEnd : edges.atStart)) {anchor = null; return 0;}
    if (anchor?.step !== step) {anchor = {step, y: nextY}; return 0;}
    if (Math.abs(nextY - anchor.y) < OVERSCROLL_DISTANCE) return 0;
    done = true;
    return step;
  };
}

/** Accumulates wheel travel at a page edge; a pause or a direction change starts over. */
export function wheelOverscroll() {
  let sum = 0, direction: PageStep = 0, last = -Infinity, cooldown = -Infinity;
  return (deltaX: number, deltaY: number, edges: PageEdges, now: number): PageStep => {
    if (Math.abs(deltaY) <= Math.abs(deltaX) || now < cooldown) return 0;
    const step: PageStep = deltaY > 0 ? 1 : -1;
    if (!(step === 1 ? edges.atEnd : edges.atStart)) {sum = 0; return 0;}
    if (step !== direction || now - last > WHEEL_IDLE) sum = 0;
    sum += Math.abs(deltaY); direction = step; last = now;
    if (sum < WHEEL_DISTANCE) return 0;
    sum = 0; cooldown = now + WHEEL_COOLDOWN;
    return step;
  };
}
