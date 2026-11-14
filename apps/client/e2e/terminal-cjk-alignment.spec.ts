import {expect,test,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {mountThemeRenderingHarness} from './fixtures/ThemeRenderingHarness';
declare global {interface Window {themeRenderer:ReturnType<typeof mountThemeRenderingHarness>}}

const fixture=(name:string)=>readFileSync(new URL(`./fixtures/${name}`,import.meta.url)).toString('base64');
const red=(text:string)=>`\x1b[31m${text}\x1b[0m`;
// CellBoxCjk.ttf draws every CJK glyph as a solid box one em wide, 0.1 em in from the left of a 1.2 em (two cell) advance.
const fontSize=14,boxWidth=fontSize,boxInset=fontSize*0.1;

/** Selects Liberation Mono as the terminal font and the box face as the CJK fallback through the product's own font store, then mounts a real xterm. */
async function mount(page:Page) {
  await page.goto('/');
  await page.evaluate(async([mono,cjk])=>{
    const {importFont,selectFont}=await import('/src/fonts.ts');
    for(const [role,name,data] of [['primary','mono.ttf',mono],['cjk','box.ttf',cjk]] as const) {
      const buffer=Uint8Array.from(atob(data),char=>char.charCodeAt(0)).buffer;
      await selectFont(role,await importFont({name,size:buffer.byteLength,arrayBuffer:async()=>buffer}));
    }
    window.themeRenderer=(await import('/e2e/fixtures/ThemeRenderingHarness.ts')).mountThemeRenderingHarness();
  },[fixture('LiberationMono-Regular.ttf'),fixture('CellBoxCjk.ttf')]);
}

type Ink='cjk'|'latin'|undefined;
/** Screenshots one terminal row and classifies each pixel column as holding CJK (red) ink, Latin (light grey) ink or neither. */
async function inkColumns(page:Page,row:number) {
  const {left,top,cellWidth,cellHeight}=await page.evaluate(()=>window.themeRenderer.grid());
  const png=await page.screenshot({clip:{x:left,y:top+row*cellHeight,width:cellWidth*36,height:cellHeight}});
  const columns=await page.evaluate(async base64=>{
    const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),char=>char.charCodeAt(0))],{type:'image/png'}));
    const context=new OffscreenCanvas(bitmap.width,bitmap.height).getContext('2d')!;
    context.drawImage(bitmap,0,0);
    const {data,width,height}=context.getImageData(0,0,bitmap.width,bitmap.height);
    const kinds:Ink[]=Array(width).fill(undefined);
    for(let x=0;x<width;x++)for(let y=0;y<height;y++) {
      const [r,g,b]=data.subarray((y*width+x)*4,(y*width+x)*4+3);
      if(r-g>60)kinds[x]??='cjk';
      else if(r>120&&Math.abs(r-g)<20&&Math.abs(g-b)<20)kinds[x]='latin';
    }
    return kinds;
  },png.toString('base64'));
  return {columns,cellWidth};
}

/** One letter per cell, 'c' CJK ink, 'l' Latin ink, '.' empty: ink must sit in the cells the buffer assigns each character. */
function inkMap({columns,cellWidth}:{columns:Ink[];cellWidth:number},cells:number) {
  return Array.from({length:cells},(_,cell)=>{
    const kinds=columns.slice(Math.round(cell*cellWidth),Math.round((cell+1)*cellWidth));
    return kinds.includes('latin')?'l':kinds.includes('cjk')?'c':'.';
  }).join('');
}

/** Where each solid CJK glyph starts, in pixels, and how wide it is. */
function boxes(columns:Ink[]) {
  const found:{start:number;width:number}[]=[];
  columns.forEach((kind,x)=>{
    if(kind!=='cjk')return;
    if(columns[x-1]==='cjk')found[found.length-1].width++;else found.push({start:x,width:1});
  });
  return found;
}

test('mixed Latin and CJK rows keep every glyph in the columns xterm assigns it',async({page})=>{
  await mount(page);
  await page.evaluate(([row0,row1,row2])=>window.themeRenderer.write(`${row0}\r\n${row1}\r\n${row2}\r\n`),[
    `ab${red('あ')}c${red('漢字')}d${red('한Ａ')}e`,
    `${red('漢字')}ab${red('あ')}`,
    `${'a'.repeat(35)}${red('あ')}`,
  ]);
  const buffer=await page.evaluate(()=>window.themeRenderer.buffer());
  const cells=(row:number,from:number,count:number)=>buffer[row].slice(from,from+count).map(cell=>[cell!.chars,cell!.width]);
  expect(cells(0,0,15)).toEqual([['a',1],['b',1],['あ',2],['',0],['c',1],['漢',2],['',0],['字',2],['',0],['d',1],['한',2],['',0],['Ａ',2],['',0],['e',1]]);
  expect(cells(1,0,8)).toEqual([['漢',2],['',0],['字',2],['',0],['a',1],['b',1],['あ',2],['',0]]);
  // A wide character that does not fit in the last column wraps whole and leaves that cell empty.
  expect(cells(2,34,2)).toEqual([['a',1],['',1]]);
  expect(cells(3,0,2)).toEqual([['あ',2],['',0]]);

  const {cellWidth}=await page.evaluate(()=>window.themeRenderer.grid());
  for(const [row,cellCount,map,glyphColumns] of [
    [0,15,'llcclcccclccccl',[2,5,7,10,12]],
    [1,8,'ccccllcc',[0,2,6]],
    [2,36,`${'l'.repeat(35)}.`,[]],
    [3,4,'cc..',[0]],
  ] as const) {
    const ink=await inkColumns(page,row);
    expect(inkMap(ink,cellCount),`row ${row} ink per cell`).toBe(map);
    const found=boxes(ink.columns);
    expect(found,`row ${row} glyph boxes`).toHaveLength(glyphColumns.length);
    glyphColumns.forEach((column,index)=>{
      expect(Math.abs(found[index].start-(column*cellWidth+boxInset)),`row ${row} glyph ${index} start`).toBeLessThanOrEqual(1);
      expect(Math.abs(found[index].width-boxWidth),`row ${row} glyph ${index} width`).toBeLessThanOrEqual(1);
    });
  }
});
