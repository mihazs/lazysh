import {createHash} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {notoFont} from '../../src/fontDownload';

const pinned=(bytes:Buffer)=>bytes.byteLength===notoFont.bytes&&createHash('sha256').update(bytes).digest('hex')===notoFont.sha256;

/** The pinned CJK font's bytes from `directory`, fetched into it from the pinned URL (and checked against the pinned length and SHA-256) when absent or altered. */
export async function pinnedFont(directory:string) {
  const file=join(directory,notoFont.sha256);
  const cached=await readFile(file).catch(()=>undefined);
  if(cached&&pinned(cached))return cached;
  const response=await fetch(notoFont.url,{redirect:'error',signal:AbortSignal.timeout(120_000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  if(response.status!==200||!pinned(bytes))throw new Error('The pinned font download does not match its pinned length and SHA-256');
  await mkdir(directory,{recursive:true});
  // Both Playwright projects may fetch at once; a rename never exposes a partial file.
  const partial=`${file}.${process.pid}.partial`;
  await writeFile(partial,bytes);await rename(partial,file);
  return bytes;
}
