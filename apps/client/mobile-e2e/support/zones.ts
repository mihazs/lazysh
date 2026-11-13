/** What the system reserves at the edges, in device pixels, read from the window manager while the overlay is active. */
export interface SystemZones {left: number; right: number; bottomMandatory: number}

/**
 * The live gesture zones from `dumpsys window displays`. Android 13 names the insets sources `ITYPE_LEFT_GESTURES`,
 * `ITYPE_RIGHT_GESTURES` and `ITYPE_BOTTOM_MANDATORY_GESTURES` and prints each frame as `[left,top][right,bottom]`.
 */
export function parseSystemZones(dump: string): SystemZones {
  const frame = (type: string) => {
    const match = new RegExp(`type=ITYPE_${type} frame=\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]`).exec(dump);
    if (!match) throw new Error(`dumpsys window shows no ${type} insets source: the format of this Android version is not read yet`);
    return match.slice(1).map(Number) as [number, number, number, number];
  };
  const [, , leftEdge] = frame('LEFT_GESTURES'), [rightStart, , rightEdge] = frame('RIGHT_GESTURES'), [, bottomStart, , bottomEdge] = frame('BOTTOM_MANDATORY_GESTURES');
  return {left: leftEdge, right: rightEdge - rightStart, bottomMandatory: bottomEdge - bottomStart};
}
