// @vitest-environment jsdom
import {afterEach,beforeAll,describe,expect,it} from 'vitest';
import {herdrNavigationCell,herdrOnScreen} from './herdrNavigationCells';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {stubMatchMedia} from './test/stubMatchMedia';
import type {TerminalAdapter,TerminalMountTarget} from './terminalAdapter';
import {createXtermAdapter} from './xterm/contractHarness';
import {createHeadlessCore} from './xterm/nativeCoreHeadless';

const columns=46,scrollbackLines=1000;
let anchors=0;
const anchor=()=>{const element=document.createElement('div');element.id=`herdr-anchor-${anchors++}`;document.body.append(element);return element;};
type Backend={open:(rows:number)=>Promise<TerminalAdapter>|TerminalAdapter;target:()=>TerminalMountTarget};
/** Both backends over the same bytes: the real xterm adapter, and the native adapter over the stand-in core, which serves rows from a bounded window of right-trimmed text. */
const backends:Record<string,Backend>={
  'xterm.js':{open:rows=>createXtermAdapter({cols:columns,rows,scrollback:scrollbackLines}),target:()=>({kind:'dom',element:anchor()})},
  'native (stand-in core)':{open:rows=>openNativeTerminalAdapter(createHeadlessCore({columns,rows,scrollbackLines}),{refreshMs:1}),target:()=>({kind:'native',anchorId:anchor().id})},
};
const made:TerminalAdapter[]=[];
beforeAll(stubMatchMedia);
afterEach(async()=>{await Promise.all(made.splice(0).map(adapter=>adapter.dispose()));});

/** `above` rows of history and then `rows` on a 46-column terminal, read from `viewportY`. */
async function screenOf({open,target}:Backend,rows:string[],viewportY=0,above=viewportY) {
  const adapter=await open(rows.length);
  made.push(adapter);
  await adapter.attach(target());
  const write=(text:string)=>adapter.write!(new TextEncoder().encode(text));
  await write([...Array(above).fill('history'),...rows].join('\r\n'));
  adapter.scroll({kind:'toRow',row:viewportY});
  // The native adapter sends a scroll to its core in order with the writes, so this empty write is applied after it.
  await write('');
  return adapter;
}
const header=['● Development  tab 1',`${' 1 blocked'.padEnd(36)}│ switch  `,'agent output'];
const switcher=[` switch${' '.repeat(29)}│  close  `,'','● Development','● codex-builder'];

describe.each(Object.entries(backends))("Herdr's own navigation inside the terminal on %s",(_name,backend)=>{
  const screen=(rows:string[],viewportY?:number,above?:number)=>screenOf(backend,rows,viewportY,above);
  it('is the switch button over the top right two rows',async()=>{
    const terminal=await screen(header);
    for(const row of [0,1])expect(herdrNavigationCell(terminal,40,row)).toBe(true);
    expect(herdrNavigationCell(terminal,36,1)).toBe(true);
    expect(herdrNavigationCell(terminal,35,1)).toBe(false);
    expect(herdrNavigationCell(terminal,40,2)).toBe(false);
  });
  it('is every cell of the open switcher',async()=>{
    const terminal=await screen(switcher);
    for(const [column,row] of [[2,0],[40,1],[5,3],[20,12]])expect(herdrNavigationCell(terminal,column,row)).toBe(true);
  });
  it('is not an agent that merely prints the word',async()=>{
    expect(herdrNavigationCell(await screen(['claude','please switch',`${' '.repeat(40)}switch`]),40,1)).toBe(false);
    expect(herdrNavigationCell(await screen(['switch to close']),3,0)).toBe(false);
  });
  it('is on screen while Herdr draws it on the live screen, wherever the reader is scrolled to',async()=>{
    expect(herdrOnScreen(await screen(header))).toBe(true);
    expect(herdrOnScreen(await screen(switcher))).toBe(true);
    expect(herdrOnScreen(await screen(['dev@box:~$ ','ls']))).toBe(false);
    expect(herdrOnScreen(await screen(header,0,5))).toBe(true);
  });
  it('follows the visible rows, not the live screen, once the reader has scrolled up into history',async()=>{
    expect(herdrNavigationCell(await screen(header,5),40,1)).toBe(true);
    expect(herdrNavigationCell(await screen(header,0,5),40,1)).toBe(false);
  });
  it('finds the button right of wide characters, by columns and not by characters',async()=>{
    const terminal=await screen(['● 開発','日本語日本語日本語'+' '.repeat(18)+'│ switch  ','agent output']);
    expect(herdrNavigationCell(terminal,36,1)).toBe(true);
    expect(herdrNavigationCell(terminal,35,1)).toBe(false);
  });
  it('is on screen when the reader has scrolled far up into history',async()=>{
    expect(herdrOnScreen(await screen(header,0,200))).toBe(true);
    expect(herdrOnScreen(await screen(['dev@box:~$ ','ls'],0,200))).toBe(false);
  });
});
