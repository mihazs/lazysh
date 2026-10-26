export const attachmentReceipt='4d1c9ace-94cf-4588-8775-3888061a05bd';
export const attachmentSession='ssh:attachment-locale';
export const attachmentPath="/work/raw {{path}}'s <file>.txt";
export const attachmentDraft='My exact prompt {{name}} <img src=secret> 中文';
export const attachmentBytes=[0,255,10,39,128,65];
/** Header-only fixture: browser image decoding is mocked in the native renderer tests. */
export function attachmentPngHeader(width=100,height=80){
  const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);
  const view=new DataView(bytes.buffer);view.setUint32(8,13);view.setUint32(12,0x49484452);view.setUint32(16,width);view.setUint32(20,height);return bytes;
}
export function attachmentFile(bytes=new Uint8Array(attachmentBytes),name='raw {{name}}.txt',type='text/plain'){
  const file=new File([new Uint8Array(bytes)],name,{type});Object.defineProperty(file,'arrayBuffer',{value:async()=>new Uint8Array(bytes).buffer});return file;
}
