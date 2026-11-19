import {expect,type Page} from '@playwright/test';
import {BackendMismatchError,onAdapter,terminalSelection} from '../../src/e2eTerminalBackend';
import type {TerminalAdapter} from '../../src/terminalAdapter';

export {onAdapter,terminalSelection};

/** Waits until the terminal on screen has a drawn screen to measure. */
export const terminalDrawn=(page:Page)=>expect.poll(()=>onAdapter(page,adapter=>{const bounds=adapter.screenBounds();return !!bounds&&bounds.width>0&&bounds.height>0;}).catch(error=>{if(error instanceof BackendMismatchError)throw error;return false;})).toBe(true);

export const terminalViewport=(page:Page)=>onAdapter(page,adapter=>adapter.viewport());
export const terminalBounds=(page:Page)=>onAdapter(page,adapter=>adapter.screenBounds());
export const terminalSize=(page:Page)=>onAdapter(page,adapter=>adapter.size());

/** The text of each row the screen shows. */
export const terminalRows=(page:Page)=>onAdapter(page,adapter=>{const {top,rows}=adapter.viewport();return adapter.readRows!(top,rows);});
export const screenText=async(page:Page)=>(await terminalRows(page)).join('\n');

/** The centre of one screen cell in client coordinates. */
export const terminalCell=(page:Page,row:number,column:number)=>onAdapter(page,(adapter,at)=>{
  const bounds=adapter.screenBounds()!,{columns,rows}=adapter.size();
  return {x:bounds.left+(at.column+.5)*bounds.width/columns,y:bounds.top+(at.row+.5)*bounds.height/rows};
},{row,column});
