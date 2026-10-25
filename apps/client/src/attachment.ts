export const ATTACHMENT_LIMIT = 10 * 1024 * 1024;
const PIXEL_LIMIT = 8 * 1024 * 1024;
export type ImageSize = { width: number; height: number; mime: 'image/png' | 'image/jpeg' };
export type Crop = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export function checkAttachment(file: Pick<File, 'size' | 'name'>): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > ATTACHMENT_LIMIT) throw new Error('Choose a file no larger than 10 MiB.');
  if (!file.name || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) throw new Error('Choose a file with a name without slashes or control characters.');
}

export function checkDestination(path: string): void {
  if (!path.trim() || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Enter a destination without control characters, no longer than 4096 characters.');
}

export function shellPath(path: string): string {
  checkDestination(path);
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function dimensions(width: number, height: number, mime: ImageSize['mime']): ImageSize {
  if (!width || !height || width > 8192 || height > 8192 || width * height > PIXEL_LIMIT) throw new Error('Image editing supports at most 8 megapixels and 8192 pixels per side. Upload the original file or resize it first.');
  return { width, height, mime };
}

// Check declared dimensions before asking the browser to allocate decoded pixels.
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('Invalid PNG header.');
    return dimensions(view.getUint32(16), view.getUint32(20), 'image/png');
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG header.');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('Invalid JPEG segment.');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) throw new Error('Invalid JPEG dimensions.');
        return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3), 'image/jpeg');
      }
      offset += length;
    }
    throw new Error('JPEG dimensions are missing.');
  }
  return null;
}

export function validateCrop(crop: Crop, size: ImageSize): Crop {
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > size.width || crop.y + crop.height > size.height) throw new Error('The crop must stay inside the image and be at least one pixel wide and high.');
  return crop;
}

export function imagePoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, size: ImageSize): Point {
  if (!rect.width || !rect.height) throw new Error('Image preview has no size.');
  return { x: Math.max(0, Math.min(size.width, (clientX - rect.left) * size.width / rect.width)), y: Math.max(0, Math.min(size.height, (clientY - rect.top) * size.height / rect.height)) };
}
