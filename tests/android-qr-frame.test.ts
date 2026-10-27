import {expect,test,spyOn} from 'bun:test';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportQrFrame,qrFrameRelativePath,readQrFrame,validateQrFrame,QR_FRAME_LIMIT} from './support/androidQrFrame';
import {OwnedProcess} from './support/androidSsh';

const fixture=fileURLToPath(new URL('../apps/client/src-tauri/fixtures/theme-qr.png',import.meta.url));
const bytes=Buffer.from(await Bun.file(fixture).arrayBuffer());
const ownedImage=['-e',`process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}))`];
test('frame destinations accept exactly the fresh lowercase nonce',()=>{
  expect(qrFrameRelativePath('a'.repeat(32))).toBe(`cache/lazysh-qr-frame-${'a'.repeat(32)}.png`);
  for(const value of ['', '../private', 'A'.repeat(32), 'a'.repeat(31)])expect(()=>qrFrameRelativePath(value)).toThrow('Invalid owned QR frame nonce');
});
test('bounded frame validation rejects non-raster, oversized and excessive dimensions',()=>{
  expect(validateQrFrame(bytes)===bytes).toBe(true);
  const wide=Buffer.from(bytes);wide.writeUInt32BE(501,16);
  const empty=Buffer.from(bytes);empty.writeUInt32BE(0,20);
  for(const invalid of [Buffer.from('<svg/>'),Buffer.alloc(QR_FRAME_LIMIT+1),wide,empty])expect(()=>validateQrFrame(invalid)).toThrow('Invalid owned QR frame');
});
test.skipIf(process.platform!=='linux')('owned foreground binary reader preserves PNG bytes and refuses excess output without logging it',async()=>{
  expect((await readQrFrame(process.execPath,ownedImage)).equals(bytes)).toBe(true);
  await expect(readQrFrame(process.execPath,['-e',`process.stdout.write(Buffer.alloc(${QR_FRAME_LIMIT+1}));setInterval(()=>{},1000)`])).rejects.toThrow('Owned QR frame exceeds byte limit');
  const failed=await readQrFrame(process.execPath,['-e',"process.stdout.write('private-frame-bytes');process.stderr.write('private-frame-error');process.exit(31)"]).catch(error=>error as Error);
  expect((failed as Error).message).toBe('Owned fixture failed: owned QR binary export; exit=31');
},8_000);
test.skipIf(process.platform!=='linux')('finished timeout owns exactly one teardown and preserves its deadline failure',async()=>{
  const stop=OwnedProcess.prototype.stop;
  let calls=0;
  const observed=spyOn(OwnedProcess.prototype,'stop').mockImplementation(async function(this:OwnedProcess){calls++;await stop.call(this);});
  try {
    await expect(readQrFrame(process.execPath,['-e','setInterval(()=>{},1000)'],30)).rejects.toThrow('Owned fixture deadline: owned QR binary export');
    expect(calls).toBe(1);
  }finally{observed.mockRestore();}
},4_000);
test.skipIf(process.platform!=='linux')('frame export writes one private artifact and never overwrites another file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-qr-frame-'));
  try{
    const output=join(directory,'qr-camera','owned-frame.png');
    await exportQrFrame(process.execPath,ownedImage,output,3_000);
    expect((await readFile(output)).equals(bytes)).toBe(true);expect((await stat(output)).mode&0o777).toBe(0o600);
    await expect(exportQrFrame(process.execPath,ownedImage,output,3_000)).rejects.toMatchObject({code:'EEXIST'});
    expect((await readFile(output)).equals(bytes)).toBe(true);
  }finally{await rm(directory,{recursive:true,force:true});}
},8_000);
