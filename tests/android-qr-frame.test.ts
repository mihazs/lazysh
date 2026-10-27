import {expect,test,spyOn} from 'bun:test';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportQrFrame,qrFrameRelativePath,readQrFrame,validateQrFrame,QR_FRAME_LIMIT,qrFrameFailureMetadata,type QrFrameFailure} from './support/androidQrFrame';
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

async function withFrameDirectory(work:(directory:string)=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),'lazysh-qr-report-'));
  try{await work(directory);}finally{await rm(directory,{recursive:true,force:true});}
}
async function exportFailure(program:string,args:string[],output:string,wait=3_000){
  const reports:Readonly<QrFrameFailure>[]=[];
  const error=await exportQrFrame(program,args,output,wait,value=>{reports.push(value);}).then(()=>undefined,error=>error as Error);
  expect(error instanceof Error).toBe(true);
  expect(reports).toHaveLength(1);
  expect(Object.keys(reports[0]).sort()).toEqual(['byteCount','exitCode','phase','reason','signal','truncated']);
  expect(JSON.stringify(reports).includes('private-frame')).toBe(false);
  expect(JSON.stringify(reports).includes(output)).toBe(false);
  return {error,reports};
}
test('export failure metadata reconstructs a finite snapshot without private fields or getter data',()=>{
  const finite:QrFrameFailure={phase:'write',reason:'exists',exitCode:0,signal:null,byteCount:641,truncated:false};
  expect(qrFrameFailureMetadata({...finite,path:'private-frame-path',stderr:'private-frame-error'})).toEqual(finite);
  for(const invalid of [{...finite,reason:'private-frame-error'},{...finite,byteCount:QR_FRAME_LIMIT+2},{...finite,exitCode:-1},{...finite,signal:'private-frame-signal'},null])expect(qrFrameFailureMetadata(invalid)).toBeUndefined();
  let reads=0;
  expect(qrFrameFailureMetadata({...finite,get phase(){return ++reads===1?'write':'private-frame-path';}})).toEqual(finite);
  expect(reads).toBe(1);
  expect(qrFrameFailureMetadata({...finite,get reason(){throw new Error('private-frame-error');}})).toBeUndefined();
});
test.skipIf(process.platform!=='linux')('export reports missing executable and actual foreground nonzero exit without captured diagnostics',async()=>{
  await withFrameDirectory(async directory=>{
    const output=join(directory,'owned.png');
    const absent=await exportFailure(join(directory,'no-executable'),[],output);
    expect(absent.reports[0]).toEqual({phase:'spawn',reason:'unavailable',exitCode:null,signal:null,byteCount:0,truncated:false});
    const failed=await exportFailure(process.execPath,['-e',"process.stdout.write('private-frame-bytes');process.stderr.write('private-frame-error');process.exit(31)"],output);
    expect(failed.reports[0]).toEqual({phase:'process',reason:'failed',exitCode:31,signal:null,byteCount:19,truncated:false});
    expect(failed.error?.message).toBe('Owned fixture failed: owned QR binary export; exit=31');
  });
},8_000);
test.skipIf(process.platform!=='linux')('export preserves its deadline failure and reports only post-teardown status',async()=>{
  await withFrameDirectory(async directory=>{
    const failed=await exportFailure(process.execPath,['-e','setInterval(()=>{},1000)'],join(directory,'owned.png'),30);
    expect(failed.error?.message).toBe('Owned fixture deadline: owned QR binary export');
    expect(failed.reports[0]).toMatchObject({phase:'process',reason:'failed',byteCount:0,truncated:false});
    expect(['SIGTERM','SIGKILL']).toContain(failed.reports[0].signal);
  });
},4_000);
test.skipIf(process.platform!=='linux')('export reports actual size, header and dimension rejection phases',async()=>{
  await withFrameDirectory(async directory=>{
    const output=join(directory,'owned.png');
    const oversized=await exportFailure(process.execPath,['-e',`process.stdout.write(Buffer.alloc(${QR_FRAME_LIMIT+1}));setInterval(()=>{},1000)`],output);
    expect(oversized.reports[0]).toMatchObject({phase:'bytes',reason:'limit',byteCount:QR_FRAME_LIMIT+1,truncated:true});
    const header=await exportFailure(process.execPath,['-e','process.stdout.write(Buffer.alloc(32))'],output);
    expect(header.reports[0]).toEqual({phase:'header',reason:'invalid',exitCode:0,signal:null,byteCount:32,truncated:false});
    const dimensions=await exportFailure(process.execPath,['-e',`const b=require('fs').readFileSync(${JSON.stringify(fixture)});b.writeUInt32BE(501,16);process.stdout.write(b)`],output);
    expect(dimensions.reports[0]).toEqual({phase:'dimensions',reason:'invalid',exitCode:0,signal:null,byteCount:bytes.length,truncated:false});
  });
},8_000);
test.skipIf(process.platform!=='linux')('export reports native directory and exclusive-write failures while preserving existing files',async()=>{
  await withFrameDirectory(async directory=>{
    const blocker=join(directory,'blocker');await writeFile(blocker,'owned');
    const failedDirectory=await exportFailure(process.execPath,ownedImage,join(blocker,'frame.png'));
    expect(failedDirectory.reports[0]).toMatchObject({phase:'directory',reason:'exists',exitCode:0,byteCount:bytes.length,truncated:false});
    const output=join(directory,'owned.png');await writeFile(output,'owned');
    const failedWrite=await exportFailure(process.execPath,ownedImage,output);
    expect(failedWrite.reports[0]).toMatchObject({phase:'write',reason:'exists',exitCode:0,byteCount:bytes.length,truncated:false});
    expect((failedWrite.error as NodeJS.ErrnoException)?.code).toBe('EEXIST');
    expect(await readFile(output,'utf8')).toBe('owned');
  });
},8_000);
test.skipIf(process.platform!=='linux')('reporter failure is attempted once and cannot replace original process or file failures',async()=>{
  await withFrameDirectory(async directory=>{
    const output=join(directory,'owned.png');let calls=0;
    const report=()=>{calls++;throw new Error('private-frame-reporter');};
    const failed=await exportQrFrame(process.execPath,['-e','process.exit(31)'],output,3_000,report).catch(error=>error as Error);
    expect(calls).toBe(1);expect((failed as Error).message).toBe('Owned fixture failed: owned QR binary export; exit=31');
    await writeFile(output,'owned');calls=0;
    const exists=await exportQrFrame(process.execPath,ownedImage,output,3_000,report).catch(error=>error as NodeJS.ErrnoException);
    expect(calls).toBe(1);expect((exists as NodeJS.ErrnoException).code).toBe('EEXIST');
  });
},8_000);
test.skipIf(process.platform!=='linux')('binary export preserves a PNG-shaped envelope beyond the text cap without claiming decoder acceptance',async()=>{
  await withFrameDirectory(async directory=>{
    // Existing owned PNG header plus padding exercises transport, not full PNG validation/decoding.
    const envelope=Buffer.concat([bytes,Buffer.alloc(20*1024)]),output=join(directory,'envelope.png');
    const args=['-e',`process.stdout.write(Buffer.concat([require('fs').readFileSync(${JSON.stringify(fixture)}),Buffer.alloc(20*1024)]))`];
    await exportQrFrame(process.execPath,args,output,3_000);
    expect((await readFile(output)).equals(envelope)).toBe(true);
    expect((await stat(output)).mode&0o777).toBe(0o600);
  });
},8_000);
