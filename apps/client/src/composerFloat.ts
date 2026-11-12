/** Where the floating composer sits on this device, as distances from the left and bottom edges of the terminal area. */
export type ComposerFloat = {left: number; bottom: number};
export type Size = {width: number; height: number};

const key = 'lazysh.composerFloat.v1';
/** Space kept between the panel and the edges of the terminal area. */
export const floatMargin = 8;

/** Keeps the whole panel inside the terminal area; a panel wider or taller than the area pins to its start edge. */
export function clampFloat(place: ComposerFloat, area: Size, panel: Size): ComposerFloat {
  const clamp = (value: number, room: number) => Math.round(Math.max(0, Math.min(value, room)));
  return {left: clamp(place.left, area.width - panel.width), bottom: clamp(place.bottom, area.height - panel.height)};
}

/** A band of the terminal area, in the area's own coordinates measured from its top. */
export type Band = {top: number; bottom: number};

/**
 * First use: centred over the bottom edge, where the docked composer would have sat, unless that would cover
 * the cursor row, which is where the user is typing: then the panel starts at the top edge instead.
 */
export function defaultFloat(area: Size, panel: Size, cursor?: Band | null): ComposerFloat {
  const atBottom = clampFloat({left: (area.width - panel.width) / 2, bottom: floatMargin}, area, panel);
  const covers = cursor && cursor.bottom > area.height - floatMargin - panel.height && cursor.top < area.height - floatMargin;
  return covers ? {...atBottom, bottom: clampFloat({left: 0, bottom: area.height - panel.height - floatMargin}, area, panel).bottom} : atBottom;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e5;

/** The saved place, or null when nothing valid is stored. Storage may be unavailable or hold anything. */
export function loadFloat(): ComposerFloat | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const {left, bottom} = value as Record<string, unknown>;
    return finite(left) && finite(bottom) ? {left, bottom} : null;
  } catch {return null;}
}

export function saveFloat(place: ComposerFloat) {
  try {localStorage.setItem(key, JSON.stringify(place));} catch {/* A place that cannot be saved only resets next time. */}
}
