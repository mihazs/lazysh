import {LocalUiError} from './i18n/localError';
export const ATTACHMENT_LIMIT = 10 * 1024 * 1024;
const PIXEL_LIMIT = 8 * 1024 * 1024;
export type ImageSize = { width: number; height: number; mime: 'image/png' | 'image/jpeg' };
export type Crop = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export function checkAttachment(file: Pick<File, 'size' | 'name'>): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > ATTACHMENT_LIMIT) throw new LocalUiError('attachmentFileLimit');
  if (!file.name || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) throw new LocalUiError('attachmentFileName');
}

export function checkDestination(path: string): void {
  if (!path.trim() || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw new LocalUiError('attachmentPathInvalid');
}

export function shellPath(path: string): string {
  checkDestination(path);
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function dimensions(width: number, height: number, mime: ImageSize['mime']): ImageSize {
  if (!width || !height || width > 8192 || height > 8192 || width * height > PIXEL_LIMIT) throw new LocalUiError('attachmentImageLimit');
  return { width, height, mime };
}

// Check declared dimensions before asking the browser to allocate decoded pixels.
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new LocalUiError('attachmentPngHeader');
    return dimensions(view.getUint32(16), view.getUint32(20), 'image/png');
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (const {marker,offset,length} of jpegSegments(bytes)) {
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) throw new LocalUiError('attachmentJpegDimensions');
        return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3), 'image/jpeg');
      }
    }
    throw new LocalUiError('attachmentJpegMissing');
  }
  return null;
}

/** Bounded JPEG marker traversal shared by dimension and EXIF inspection. */
export function* jpegSegments(bytes:Uint8Array):Generator<{marker:number;offset:number;length:number}> {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let offset=2;
  while(offset+3<bytes.length) {
    if(bytes[offset++]!==0xff)throw new LocalUiError('attachmentJpegHeader');
    while(bytes[offset]===0xff)offset++;
    const marker=bytes[offset++];
    if(marker===0xda || marker===0xd9)return;
    if(marker===0x01 || (marker>=0xd0&&marker<=0xd7))continue;
    if(offset+2>bytes.length)return;
    const length=view.getUint16(offset);
    if(length<2 || offset+length>bytes.length)throw new LocalUiError('attachmentJpegSegment');
    yield {marker,offset,length};offset+=length;
  }
}

export function validateCrop(crop: Crop, size: ImageSize): Crop {
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > size.width || crop.y + crop.height > size.height) throw new LocalUiError('attachmentCropInvalid');
  return crop;
}

export function imagePoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, size: ImageSize): Point {
  if (!rect.width || !rect.height) throw new LocalUiError('attachmentPreviewSize');
  return { x: Math.max(0, Math.min(size.width, (clientX - rect.left) * size.width / rect.width)), y: Math.max(0, Math.min(size.height, (clientY - rect.top) * size.height / rect.height)) };
}

/** SFTP separators are `/` even when this client or the remote host uses Windows. */
export function uploadDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  const parent = path.slice(0,slash);
  // Preserve the complete slash prefix and both server drive-root forms.
  return /^\/*$/.test(parent) || /^\/?[A-Za-z]:$/.test(parent)
    ? path.slice(0, slash + 1) : parent;
}
