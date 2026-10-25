export type ElementSelection = { path: string; selector: string; text: string; rect: { x: number; y: number; width: number; height: number } };
export const pickerId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function elementSelection(value: unknown): ElementSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid element selection.');
  const row = value as Record<string, unknown>;
  for (const [key, limit] of [['path', 4096], ['selector', 512], ['text', 300]] as const) {
    if (typeof row[key] !== 'string' || row[key].length > limit || /[\u0000-\u001f\u007f]/.test(row[key])) throw new Error('Invalid element selection.');
  }
  if (!(row.path as string).startsWith('/') || (row.path as string).startsWith('//') || !(row.selector as string).trim() || !row.rect || typeof row.rect !== 'object' || Array.isArray(row.rect)) throw new Error('Invalid element selection.');
  const rect = row.rect as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key]) || Math.abs(rect[key]) > 100000 || ((key === 'width' || key === 'height') && rect[key] < 0)) throw new Error('Invalid element bounds.');
  }
  return { path: row.path as string, selector: row.selector as string, text: row.text as string, rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number } };
}
