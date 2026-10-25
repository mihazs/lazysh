import { expect, it } from 'vitest';
import { ATTACHMENT_LIMIT, checkAttachment, checkDestination, imagePoint, imageSize, shellPath, validateCrop } from './attachment';

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); view.setUint32(12, 0x49484452); view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
it('bounds files and rejects filenames/paths that change path structure or shell lines', () => {
  expect(() => checkAttachment({ name: 'a.txt', size: ATTACHMENT_LIMIT })).not.toThrow();
  for (const value of [{ name: '../a', size: 1 }, { name: 'a\nb', size: 1 }, { name: 'a', size: ATTACHMENT_LIMIT + 1 }]) expect(() => checkAttachment(value)).toThrow();
  for (const value of ['', '/a\0b', '/a\nb', 'a'.repeat(4097)]) expect(() => checkDestination(value)).toThrow();
  expect(shellPath("/a'b;$(touch nope)")).toBe("'/a'\\''b;$(touch nope)'");
});
it('checks image dimensions before decode and rejects huge or malformed image headers', () => {
  expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480, mime: 'image/png' });
  for (const [width, height] of [[0, 1], [8193, 1], [4000, 4000]]) expect(() => imageSize(png(width, height))).toThrow();
  expect(imageSize(new TextEncoder().encode('arbitrary file'))).toBeNull();
  expect(imageSize(new Uint8Array([255, 216, 255, 192, 0, 11, 8, 0, 100, 0, 200, 1, 1, 17, 0]))).toEqual({ width: 200, height: 100, mime: 'image/jpeg' });
  expect(() => imageSize(new Uint8Array([255, 216, 255, 192, 0, 255]))).toThrow();
});
it('bounds crop and maps scaled pointer coordinates into original image space', () => {
  const size = { width: 640, height: 480, mime: 'image/png' as const };
  expect(validateCrop({ x: 5, y: 10, width: 100, height: 100 }, size)).toEqual({ x: 5, y: 10, width: 100, height: 100 });
  for (const crop of [{ x: -1, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 641, height: 1 }, { x: 0, y: 0, width: 1.5, height: 1 }]) expect(() => validateCrop(crop, size)).toThrow();
  expect(imagePoint(170, 130, { left: 10, top: 10, width: 320, height: 240 }, size)).toEqual({ x: 320, y: 240 });
  expect(imagePoint(-1, 999, { left: 10, top: 10, width: 320, height: 240 }, size)).toEqual({ x: 0, y: 480 });
});
