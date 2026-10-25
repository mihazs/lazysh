import {expect,test} from '@playwright/test';
import type {mountThemeRenderingHarness} from './fixtures/ThemeRenderingHarness';
declare global {interface Window {themeRenderer:ReturnType<typeof mountThemeRenderingHarness>}}
async function mount(page:import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async()=>{const fixture=await import('/e2e/fixtures/ThemeRenderingHarness.ts');window.themeRenderer=fixture.mountThemeRenderingHarness();});
}
const rgb=(hex:string)=>`rgb(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')})`;
function contrast(foreground:string,background:string) {
  const channels=(value:string)=>value.match(/[\d.]+/g)!.map(Number);
  const bg=channels(background),fg=channels(foreground),alpha=fg[3]??1;
  const lum=(rgb:number[])=>rgb.slice(0,3).map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
  const a=lum(fg.map((v,i)=>i<3?v*alpha+bg[i]*(1-alpha):v)),b=lum(bg);
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}

test('light indexed palette renders both roles and inverse status lines without changing RGB or base ANSI',async({page},info)=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.write(
    '\x1b[38;5;250;48;5;237mX\x1b[0m\r\n'+
    '\x1b[7;38;5;237;48;5;250mY\x1b[0m\r\n'+
    '\x1b[38;5;231mW\x1b[0m\r\n\x1b[38;5;226mU\x1b[0m\r\n'+
    '\x1b[38;5;232mL\x1b[0m\r\n\x1b[38;5;255mH\x1b[0m\r\n'+
    '\x1b[31mA\x1b[0m\r\n\x1b[38;2;188;188;188;48;2;58;58;58mT\x1b[0m\r\n'+
    '\x1b[7mV\x1b[0m\r\n\x1b[38;5;9mE\x1b[0m\r\n'+
    '\x1b[38;5;16mM\x1b[38;5;21mN\x1b[0m\r\n'));
  const original=await page.evaluate(()=>window.themeRenderer.buffer());
  const controls=await page.evaluate(()=>['A','T','E','M','N'].map(text=>window.themeRenderer.sample(text)));
  await page.evaluate(()=>window.themeRenderer.light());
  for(const text of ['X','Y']) {
    const sample=await page.evaluate(text=>window.themeRenderer.sample(text),text);
    expect(sample).toMatchObject({foreground:rgb('#3a3a3a'),background:rgb('#bcbcbc')});
    expect(contrast(sample.foreground,sample.background)).toBeGreaterThan(4.5);
  }
  for(const [text,color] of [['W','#999999'],['U','#999900'],['L','#eeeeee'],['H','#080808']])expect(await page.evaluate(text=>window.themeRenderer.sample(text).foreground,text)).toBe(rgb(color));
  expect(await page.evaluate(()=>['A','T','E','M','N'].map(text=>window.themeRenderer.sample(text)))).toEqual(controls);
  expect(await page.evaluate(()=>window.themeRenderer.sample('V'))).toMatchObject({foreground:rgb('#fafafa'),background:rgb('#111111')});
  expect(await page.evaluate(()=>window.themeRenderer.buffer())).toEqual(original);
  await page.screenshot({path:info.outputPath('light-indexed-inverse.png')});
  await page.evaluate(()=>window.themeRenderer.theme());
  expect(await page.evaluate(()=>window.themeRenderer.sample('X'))).toMatchObject({foreground:rgb('#bcbcbc'),background:rgb('#3a3a3a')});
  await page.evaluate(()=>window.themeRenderer.paper());
  expect(await page.evaluate(()=>window.themeRenderer.sample('X').foreground)).toBe(rgb('#3a3a3a'));
  await page.evaluate(()=>window.themeRenderer.legacy());
  expect(await page.evaluate(()=>window.themeRenderer.sample('X').foreground)).toBe(rgb('#bcbcbc'));
  await page.evaluate(()=>window.themeRenderer.dispose());
});

test('light palette respects selection and decoration overrides alongside bold, dim and inverse',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.light('#336699'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1;2;38;5;250;48;5;237mD\x1b[0m\r\n\x1b[1;7mABC\x1b[0m\r\n'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('D'))).toMatchObject({foreground:'rgba(58, 58, 58, 0.5)',background:rgb('#bcbcbc')});
  expect(await page.evaluate(()=>window.themeRenderer.sample('ABC'))).toMatchObject({foreground:rgb('#fafafa'),background:rgb('#336699')});
  await page.evaluate(()=>window.themeRenderer.select(0,0,1));
  expect(await page.evaluate(()=>window.themeRenderer.sample('D'))).toMatchObject({foreground:rgb('#ffeecc'),background:rgb('#445566')});
  await page.evaluate(()=>window.themeRenderer.decorate(0,1,'#abcdef','#234567'));
  await page.evaluate(()=>window.themeRenderer.decorate(1,1,undefined,'#654321'));
  await page.evaluate(()=>window.themeRenderer.select(0,1,3));
  expect(await page.evaluate(()=>window.themeRenderer.sample('A'))).toMatchObject({foreground:rgb('#abcdef'),background:rgb('#234567')});
  expect(await page.evaluate(()=>window.themeRenderer.sample('B').background)).toBe(rgb('#654321'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('C'))).toMatchObject({foreground:rgb('#ffeecc'),background:rgb('#445566')});
  await page.evaluate(()=>window.themeRenderer.clearSelection());
  expect(await page.evaluate(()=>window.themeRenderer.sample('C'))).toMatchObject({foreground:rgb('#fafafa'),background:rgb('#336699')});
  await page.evaluate(()=>window.themeRenderer.dispose());
});

test('indexed light changes redraw scrollback and alternate buffers and SGR reset restores defaults',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.write('\x1b[38;5;250mhistory\x1b[0m\r\n'+Array.from({length:18},(_,i)=>`later${i}\r\n`).join('')));
  await page.evaluate(()=>window.themeRenderer.light());
  await page.evaluate(()=>window.themeRenderer.scrollTop());
  expect(await page.evaluate(()=>window.themeRenderer.sample('history').foreground)).toBe(rgb('#3a3a3a'));
  const history=await page.evaluate(()=>window.themeRenderer.buffer());
  await page.evaluate(()=>window.themeRenderer.theme());
  expect(await page.evaluate(()=>window.themeRenderer.sample('history').foreground)).toBe(rgb('#bcbcbc'));
  expect(await page.evaluate(()=>window.themeRenderer.buffer())).toEqual(history);
  await page.evaluate(()=>window.themeRenderer.write('\x1b[?1049h\x1b[H\x1b[38;5;250mQ\x1b[0mR\r\n'));
  await page.evaluate(()=>window.themeRenderer.light());
  expect(await page.evaluate(()=>window.themeRenderer.sample('Q').foreground)).toBe(rgb('#3a3a3a'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('R').foreground)).toBe(rgb('#111111'));
  await page.evaluate(()=>window.themeRenderer.theme());
  expect(await page.evaluate(()=>window.themeRenderer.sample('Q').foreground)).toBe(rgb('#bcbcbc'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('R').foreground)).toBe(rgb('#dddddd'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[?1049l'));
  await page.evaluate(()=>window.themeRenderer.scrollTop());
  expect(await page.evaluate(()=>window.themeRenderer.sample('history').foreground)).toBe(rgb('#bcbcbc'));
  await page.evaluate(()=>window.themeRenderer.dispose());
});


test('real DOM renderer keeps absent, bright and hex bold distinct without changing buffer attributes',async({page},info)=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.write('N\x1b[1mB\x1b[22mR\r\n\x1b[31mA\x1b[1mC\x1b[0m\r\n\x1b[1;38;5;1mI\x1b[0m\r\n\x1b[1;38;5;196mJ\x1b[0m\r\n\x1b[1;38;2;20;180;220mT\x1b[0m\r\n'));
  const original=await page.evaluate(()=>window.themeRenderer.buffer());
  expect(await page.evaluate(()=>window.themeRenderer.sample('B').foreground)).toBe(rgb('#dddddd'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('C').foreground)).toBe(rgb('#aa2222'));
  await page.evaluate(()=>window.themeRenderer.theme('bright'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('B').foreground)).toBe(rgb('#dddddd'));
  for(const text of ['C','I'])expect(await page.evaluate(text=>window.themeRenderer.sample(text).foreground,text)).toBe(rgb('#ff5555'));
  await page.evaluate(()=>window.themeRenderer.theme('#33cc77'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('B').foreground)).toBe(rgb('#33cc77'));
  for(const text of ['N','R'])expect(await page.evaluate(text=>window.themeRenderer.sample(text).foreground,text)).toBe(rgb('#dddddd'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('A').foreground)).toBe(rgb('#aa2222'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('J').foreground)).toBe(rgb('#ff0000'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('T').foreground)).toBe(rgb('#14b4dc'));
  expect(await page.evaluate(()=>window.themeRenderer.buffer())).toEqual(original);
  await page.evaluate(()=>window.themeRenderer.theme('#aabbcc'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('B').foreground)).toBe(rgb('#aabbcc'));
  await page.evaluate(()=>window.themeRenderer.theme());
  expect(await page.evaluate(()=>window.themeRenderer.sample('B').foreground)).toBe(rgb('#dddddd'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('C').foreground)).toBe(rgb('#aa2222'));
  await page.screenshot({path:info.outputPath('bold-policies.png')});
  await page.evaluate(()=>window.themeRenderer.dispose());
});

test('hex bold follows inverse, alternate buffer, selection and wide or joined glyphs',async({page},info)=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.theme('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1;7mV\x1b[0m\r\n\x1b[1;48;2;20;30;40mG\x1b[0m\r\n\x1b[1m界e\u0301😀\x1b[0m\r\n'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('V').foreground)).toBe(rgb('#101010'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('V').background)).toBe(rgb('#33cc77'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('G').foreground)).toBe(rgb('#33cc77'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('G').background)).toBe(rgb('#141e28'));
  expect((await page.evaluate(()=>window.themeRenderer.rows())).join('')).toContain('界é😀');
  const wide=await page.evaluate(()=>window.themeRenderer.spans().filter(span=>/[界e😀]/u.test(span.text??'')));
  expect(wide.length).toBeGreaterThan(0);
  for(const span of wide)expect(span.foreground).toBe(rgb('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.select(0,1,1));
  expect(await page.evaluate(()=>window.themeRenderer.sample('G').foreground)).toBe(rgb('#ffeecc'));
  await page.evaluate(()=>window.themeRenderer.select(0,1,1,false));
  expect(await page.evaluate(()=>window.themeRenderer.sample('G').foreground)).toBe(rgb('#ffeecc'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[?1049h\x1b[H\x1b[1mQ\x1b[0m\r\n'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('Q').foreground)).toBe(rgb('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.theme('#cc99ee'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('Q').foreground)).toBe(rgb('#cc99ee'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[?1049l'));
  await page.evaluate(()=>window.themeRenderer.resize());
  expect(await page.evaluate(()=>window.themeRenderer.sample('V').background)).toBe(rgb('#cc99ee'));
  await page.screenshot({path:info.outputPath('bold-inverse-selection.png')});
  await page.evaluate(()=>window.themeRenderer.write('\x1b[H\x1b[2J\x1b[1mfi\x1b[0m\r\n'));
  await page.evaluate(()=>window.themeRenderer.join());
  expect(await page.evaluate(()=>window.themeRenderer.sample('fi').foreground)).toBe(rgb('#cc99ee'));
  expect(await page.evaluate(()=>window.themeRenderer.joinedRequests())).toBeGreaterThan(0);
  await page.evaluate(()=>window.themeRenderer.dispose());
});

test('custom bold participates in actual contrast adjustment and dim rendering',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.theme('#121212'));
  await page.evaluate(()=>window.themeRenderer.contrast());
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1mK\x1b[0m\r\n\x1b[1;2mD\x1b[0m\r\n\x1b[1;7mY\x1b[0m\r\n\x1b[1;2;7mO\x1b[0m\r\n'));
  const samples=await page.evaluate(()=>['K','D','Y','O'].map(text=>window.themeRenderer.sample(text)));
  samples.forEach((sample,i)=>{
    const bg=sample.background==='rgba(0, 0, 0, 0)'?rgb('#101010'):sample.background;
    expect(contrast(sample.foreground,bg)).toBeGreaterThanOrEqual(i%2===0?4.5:2.25);
  });
  await page.evaluate(()=>window.themeRenderer.dispose());
});


test('default bold keeps faint opacity when a hex foreground is selected',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.theme('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1;2mF\x1b[0m\r\n'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('F').foreground)).toBe('rgba(51, 204, 119, 0.5)');
  await page.evaluate(()=>window.themeRenderer.dispose());
});


test('merged inverse runs preserve selection and decoration overrides through clear and theme changes',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.theme('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1;7mABCDEF\x1b[0m\r\n'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('ABCDEF').background)).toBe(rgb('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.select(1,0,2));
  expect(await page.evaluate(()=>window.themeRenderer.sample('BC'))).toMatchObject({foreground:rgb('#ffeecc'),background:rgb('#445566')});
  expect(await page.evaluate(()=>window.themeRenderer.sample('A').background)).toBe(rgb('#33cc77'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('DEF').background)).toBe(rgb('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.decorate(2,0,'#aabbcc','#234567'));
  await page.evaluate(()=>window.themeRenderer.decorate(3,0,'#fedcba'));
  await page.evaluate(()=>window.themeRenderer.decorate(4,0,undefined,'#654321'));
  await page.evaluate(()=>window.themeRenderer.select(1,0,4));
  expect(await page.evaluate(()=>window.themeRenderer.sample('B'))).toMatchObject({foreground:rgb('#ffeecc'),background:rgb('#445566')});
  expect(await page.evaluate(()=>window.themeRenderer.sample('C'))).toMatchObject({foreground:rgb('#aabbcc'),background:rgb('#234567')});
  expect(await page.evaluate(()=>window.themeRenderer.sample('D'))).toMatchObject({foreground:rgb('#fedcba'),background:rgb('#33cc77')});
  expect(await page.evaluate(()=>window.themeRenderer.sample('E'))).toMatchObject({foreground:rgb('#101010'),background:rgb('#654321')});
  expect(await page.evaluate(()=>window.themeRenderer.sample('F').background)).toBe(rgb('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.clearSelection());
  expect(await page.evaluate(()=>window.themeRenderer.sample('A').background)).toBe(rgb('#33cc77'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('B').background)).toBe(rgb('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.theme());
  expect(await page.evaluate(()=>window.themeRenderer.sample('A').background)).toBe(rgb('#dddddd'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('D').background)).toBe(rgb('#dddddd'));
  await page.evaluate(()=>window.themeRenderer.theme('#cc99ee'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('A').background)).toBe(rgb('#cc99ee'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('C').background)).toBe(rgb('#234567'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1mH\x1b[38;2;204;153;238mL\x1b[39mZ\x1b[0m\r\n'));
  for(const text of ['H','L','Z'])expect(await page.evaluate(text=>window.themeRenderer.sample(text).foreground,text)).toBe(rgb('#cc99ee'));
  await page.evaluate(()=>window.themeRenderer.theme('#33cc77'));
  for(const text of ['H','Z'])expect(await page.evaluate(text=>window.themeRenderer.sample(text).foreground,text)).toBe(rgb('#33cc77'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('L').foreground)).toBe(rgb('#cc99ee'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1;2mh\x1b[38;2;51;204;119ml\x1b[39mz\x1b[0m\r\n'));
  for(const text of ['h','z'])expect(await page.evaluate(text=>window.themeRenderer.sample(text).foreground,text)).toBe('rgba(51, 204, 119, 0.5)');
  expect(await page.evaluate(()=>window.themeRenderer.sample('l').foreground)).toBe(rgb('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.bundled());
  expect(await page.evaluate(()=>window.themeRenderer.sample('H').foreground)).toBe(rgb('#d9e0d6'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('L').foreground)).toBe(rgb('#cc99ee'));
  await page.evaluate(()=>window.themeRenderer.dispose());
});

test('dim inverse and explicit alpha decoration backgrounds do not get mistaken for dim contrast overrides',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.theme('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1;2;7mUVW\x1b[0m\r\n'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('UVW'))).toMatchObject({foreground:'rgba(16, 16, 16, 0.5)',background:rgb('#33cc77')});
  await page.evaluate(()=>window.themeRenderer.select(1,0,1));
  expect(await page.evaluate(()=>window.themeRenderer.sample('V'))).toMatchObject({foreground:rgb('#ffeecc'),background:rgb('#445566')});
  await page.evaluate(()=>window.themeRenderer.decorate(2,0,undefined,'#dddddd80'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('W').background)).toBe(rgb('#dddddd'));
  await page.evaluate(()=>window.themeRenderer.select(1,0,1,false));
  expect(await page.evaluate(()=>window.themeRenderer.sample('V'))).toMatchObject({foreground:rgb('#ffeecc'),background:rgb('#445566')});
  await page.evaluate(()=>window.themeRenderer.clearSelection());
  expect(await page.evaluate(()=>window.themeRenderer.sample('UV'))).toMatchObject({foreground:'rgba(16, 16, 16, 0.5)',background:rgb('#33cc77')});
  await page.evaluate(()=>window.themeRenderer.dispose());
});


test('light default and inverse bold use their actual foreground in the contrast calculation',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.light('#f8f8f8'));
  await page.evaluate(()=>window.themeRenderer.contrast());
  await page.evaluate(()=>window.themeRenderer.write('N\x1b[1mB\x1b[0m\r\n\x1b[1;7mJ\x1b[0m\r\n'));
  expect(await page.evaluate(()=>window.themeRenderer.sample('N').foreground)).toBe(rgb('#111111'));
  const normal=await page.evaluate(()=>window.themeRenderer.sample('B'));
  const inverse=await page.evaluate(()=>window.themeRenderer.sample('J'));
  expect(inverse.background).toBe(rgb('#f8f8f8'));
  expect(contrast(normal.foreground,rgb('#fafafa'))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(inverse.foreground,inverse.background)).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(()=>window.themeRenderer.dispose());
});


test('scrollback redraw uses the current bold policy without rewriting saved cells',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.themeRenderer.theme('#33cc77'));
  await page.evaluate(()=>window.themeRenderer.write('\x1b[1mhistory\x1b[0m\r\n'+Array.from({length:18},(_,i)=>`later${i}\r\n`).join('')));
  await page.evaluate(()=>window.themeRenderer.theme('#cc99ee'));
  await page.evaluate(()=>window.themeRenderer.scrollTop());
  expect(await page.evaluate(()=>window.themeRenderer.sample('history').foreground)).toBe(rgb('#cc99ee'));
  const original=await page.evaluate(()=>window.themeRenderer.buffer());
  await page.evaluate(()=>window.themeRenderer.theme());
  expect(await page.evaluate(()=>window.themeRenderer.sample('history').foreground)).toBe(rgb('#dddddd'));
  expect(await page.evaluate(()=>window.themeRenderer.buffer())).toEqual(original);
  await page.evaluate(()=>window.themeRenderer.dispose());
});
