import type {Edge} from '../edgeGestures';
import type {GestureInsets} from '../gestureInsets';

/**
 * What the Android shell reports under each navigation overlay (`cmd overlay enable-exclusive --category
 * com.android.internal.systemui.navbar.<name>`), and so what #1380's tests (vitest, Playwright, adb) simulate. The Home zone is the
 * launcher's 48 dp swipe-up strip; the Back zone is the overlay's edge inset.
 */
export const overlays = [
  {name: 'threebutton', insets: {left: 0, right: 0, bottom: 0, mandatoryBottom: 0, navigation: 'buttons'}},
  {name: 'gestural', insets: {left: 24, right: 24, bottom: 48, mandatoryBottom: 48, navigation: 'gesture'}},
  {name: 'gestural_wide_back', insets: {left: 32, right: 32, bottom: 48, mandatoryBottom: 48, navigation: 'gesture'}},
  {name: 'gestural_extra_wide_back', insets: {left: 40, right: 40, bottom: 48, mandatoryBottom: 48, navigation: 'gesture'}},
] as const satisfies readonly {name: string; insets: GestureInsets}[];
export type Overlay = typeof overlays[number];
/** The zone width preference: its minimum, its default and its maximum, in dp. */
export const zoneWidths = [16, 40, 96] as const;
/** Handles (the default on gesture navigation) or edge swipes (the advanced style). */
export type GestureStyle = 'handles' | 'edges';
export const gestureStyles: readonly GestureStyle[] = ['handles', 'edges'];
/** The gap between a system zone and the band beside it. */
export const bandMargin = 4;

/**
 * Distances from the screen edge, in dp, where an app swipe may start, written from the documented geometry rather than the engine's
 * helpers: gesture navigation owns [0, inset], so handles start 4 dp past it; edge swipes claim the side rows back (0 to the zone
 * width) and start the bottom swipe at the Home zone. Three buttons keep nothing at the edge.
 */
export function bandOf(insets: GestureInsets, edge: Edge, width: number, style: GestureStyle): [number, number] {
  const system = edge === 'bottom' ? Math.max(insets.bottom, insets.mandatoryBottom) : insets[edge];
  if (insets.navigation !== 'gesture') return [0, width];
  if (style === 'handles') return [system + bandMargin, system + bandMargin + width];
  return edge === 'bottom' ? [system, system + width] : [0, width];
}

/** The start positions worth trying: the screen edge, inside the system zone, both ends of the band and its middle, and just beyond it. */
export const startDistances = ([from, to]: [number, number]) => [...new Set([0, from - 1, from, Math.floor((from + to) / 2), to, to + 1])].filter(distance => distance >= 0);
