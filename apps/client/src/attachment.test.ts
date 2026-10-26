import {attachmentPngHeader as png} from './test/attachmentData';
import { expect, it } from 'vitest';
import { ATTACHMENT_LIMIT, checkAttachment, checkDestination, imagePoint, imageSize, shellPath, uploadDirectory, validateCrop } from './attachment';

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

it.each([
  ['/home/a.txt','/home'],['/a.txt','/'],['//a.txt','//'],['///a.txt','///'],['/C:/a.txt','/C:/'],
  ['C:/a.txt','C:/'],['//server/share/a.txt','//server/share'],
  ["/home/a' 世界.txt",'/home'],
])('refreshes the canonical SFTP parent of %s without client OS path rules',(path,parent)=>{
  expect(uploadDirectory(path)).toBe(parent);
});
