// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {herdrNavigationCell,herdrOnScreen} from './herdrNavigationCells';
import {XtermTerminalAdapter} from './xtermTerminalAdapter';

/** A 46-column buffer of `above` rows of history and then `rows`, read from `viewportY`, behind the real xterm adapter. */
function screen(rows:string[],viewportY=0,above=viewportY) {
  const lines=[...Array(above).fill('history'),...rows];
  return new XtermTerminalAdapter({cols:46,rows:rows.length,buffer:{active:{viewportY,baseY:above,length:lines.length,getLine:(y:number)=>lines[y]===undefined?undefined:{translateToString:(_trim:boolean,start=0,end=46)=>lines[y].padEnd(46).slice(start,end)}}}} as never);
}
const header=['● Development  tab 1',`${' 1 blocked'.padEnd(36)}│ switch  `,'agent output'];
const switcher=[` switch${' '.repeat(29)}│  close  `,'','● Development','● codex-builder'];

describe("Herdr's own navigation inside the terminal",()=>{
  it('is the switch button over the top right two rows',()=>{
    const terminal=screen(header);
    for(const row of [0,1])expect(herdrNavigationCell(terminal,40,row)).toBe(true);
    expect(herdrNavigationCell(terminal,36,1)).toBe(true);
    expect(herdrNavigationCell(terminal,35,1)).toBe(false);
    expect(herdrNavigationCell(terminal,40,2)).toBe(false);
  });
  it('is every cell of the open switcher',()=>{
    const terminal=screen(switcher);
    for(const [column,row] of [[2,0],[40,1],[5,3],[20,12]])expect(herdrNavigationCell(terminal,column,row)).toBe(true);
  });
  it('is not an agent that merely prints the word',()=>{
    expect(herdrNavigationCell(screen(['claude','please switch',`${' '.repeat(40)}switch`]),40,1)).toBe(false);
    expect(herdrNavigationCell(screen(['switch to close']),3,0)).toBe(false);
  });
  it('is on screen while Herdr draws it on the live screen, wherever the reader is scrolled to',()=>{
    const live=(rows:string[])=>screen(rows);
    expect(herdrOnScreen(live(header))).toBe(true);
    expect(herdrOnScreen(live(switcher))).toBe(true);
    expect(herdrOnScreen(live(['dev@box:~$ ','ls']))).toBe(false);
    expect(herdrOnScreen(screen(header,0,5))).toBe(true);
  });
  it('follows the visible rows, not the live screen, once the reader has scrolled up into history',()=>{
    expect(herdrNavigationCell(screen(header,5),40,1)).toBe(true);
    expect(herdrNavigationCell(screen(header,0,5),40,1)).toBe(false);
  });
});
