export const shareOrigin='https://files.example.test';
export const shareId='a'.repeat(64);
export const sharedFile={id:shareId,name:'notes.txt',mime:'text/plain',size:10,createdAt:1800000000,expiresAt:1800003600,url:`${shareOrigin}/s/${shareId}`};
export const sharePng=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j97kAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
export const shareThumbnail={mime:'image/png',data:Array.from(sharePng),width:1,height:1};
export const sharedImage={...sharedFile,name:'raw {{name}} <image>.png',mime:'image/png',size:sharePng.length};
