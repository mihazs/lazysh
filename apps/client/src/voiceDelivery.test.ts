import { expect, it } from 'vitest';
import { dictationInput } from './voiceDelivery';

it('preserves printable Unicode and whitespace and appends exactly one explicitly selected Enter',()=>{
  expect(dictationInput('  世界 👋  ',false)).toBe('  世界 👋  ');
  expect(dictationInput('  世界 👋  ',true)).toBe('  世界 👋  \r');
});
it('counts UTF-8 bytes including Enter at the native input boundary',()=>{
  expect(dictationInput('x'.repeat(65536),false)).toHaveLength(65536);
  expect(dictationInput('x'.repeat(65535),true)).toHaveLength(65536);
  expect(()=>dictationInput('x'.repeat(65536),true)).toThrow('64 KiB');
  expect(()=>dictationInput('語'.repeat(21846),false)).toThrow('64 KiB');
  expect(new TextEncoder().encode(dictationInput('語'.repeat(21845),true)).byteLength).toBe(65536);
});
it('rejects embedded Enter, terminal controls, malformed Unicode and empty text without echoing it',()=>{
  for(const text of ['', '  ', 'private\ncommand','private\rcommand','private\tcommand','private\x1b[31m','private\x00','private\x7f','private\x85','private\u2028command','private\u2029command','private\ud800']){
    let error:unknown;try{dictationInput(text,true);}catch(value){error=value;}
    expect(error).toBeInstanceOf(Error);expect((error as Error).message).not.toContain('private');
  }
});
