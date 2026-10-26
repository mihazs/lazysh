import {imageSize,jpegSegments} from './attachment';
import {LocalUiError} from './i18n/localError';

export type RecordedImage = {mimeType:'image/png'|'image/jpeg'; data:string; width:number; height:number};
const invalid = () => new LocalUiError('chatImageInvalid');

export function recordedImage(value: unknown): RecordedImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const image=value as RecordedImage;
  if (Object.keys(value).length!==4 || !['image/png','image/jpeg'].includes(image.mimeType)
    || typeof image.data!=='string' || !image.data.length || image.data.length>64*1024
    || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width<1 || image.height<1 || image.width>2048 || image.height>2048
    || image.width*image.height>1024*1024) throw invalid();
  const bytes=recordedImageBytes(image);
  let size;
  try {size=imageSize(bytes);} catch {throw invalid();}
  if (!size || size.mime!==image.mimeType || size.width!==image.width || size.height!==image.height) throw invalid();
  if (image.mimeType==='image/png') {
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let offset=8, ended=false;
    while(offset+12<=bytes.length) {
      const length=view.getUint32(offset), end=offset+12+length;
      if(end>bytes.length)throw invalid();
      const tag=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
      if(['acTL','fcTL','fdAT'].includes(tag))throw invalid();
      if(tag==='IEND') {if(length!==0 || end!==bytes.length)throw invalid();ended=true;break;}
      offset=end;
    }
    if(!ended)throw invalid();
  }
  return {mimeType:image.mimeType,data:image.data,width:image.width,height:image.height};
}

export function recordedImageBytes(image:RecordedImage):Uint8Array<ArrayBuffer> {
  let decoded:string;
  try {decoded=atob(image.data);if(btoa(decoded)!==image.data)throw invalid();} catch {throw invalid();}
  if(decoded.length>48*1024)throw invalid();
  return Uint8Array.from(decoded,char=>char.charCodeAt(0));
}

// Read only the bounded JPEG APP1/IFD0 orientation. It affects display, not the
// independently checked encoded dimensions. Unknown EXIF is left unoriented.
function orientation(bytes:Uint8Array):number {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(const {marker,offset,length} of jpegSegments(bytes)) {
    const end=offset+length;
    if(marker===0xe1 && String.fromCharCode(...bytes.subarray(offset+2,offset+8))==='Exif\0\0') {
      const tiff=offset+8;
      if(tiff+8>end)return 1;
      const order=view.getUint16(tiff), little=order===0x4949;
      if((!little&&order!==0x4d4d)||view.getUint16(tiff+2,little)!==42)return 1;
      const directory=tiff+view.getUint32(tiff+4,little);
      if(directory<tiff+8 || directory+2>end)return 1;
      const count=view.getUint16(directory,little);
      if(directory+2+count*12>end)return 1;
      for(let i=0;i<count;i++) {
        const entry=directory+2+i*12;
        if(view.getUint16(entry,little)===0x0112 && view.getUint16(entry+2,little)===3 && view.getUint32(entry+4,little)===1) {
          const value=view.getUint16(entry+8,little);return value>=1&&value<=8?value:1;
        }
      }
      return 1;
    }
  }
  return 1;
}

export function recordedDisplaySize(image:RecordedImage,bytes:Uint8Array):{width:number;height:number} {
  const rotated=image.mimeType==='image/jpeg' && orientation(bytes)>=5;
  return {width:rotated?image.height:image.width,height:rotated?image.width:image.height};
}
