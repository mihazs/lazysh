import {expect,type Page} from '@playwright/test';
import type {TerminalAdapter} from '../../src/terminalAdapter';

/**
 * Runs `use` in the page against the TerminalAdapter of the terminal drawn on screen: rows (`readRows`), cursor, viewport,
 * selection and geometry come from the adapter, never from a backend's DOM or buffer, so a spec asserts the same way on any
 * backend. The App keeps its sessions in React state, so the adapter is taken from the visible `TerminalPane`'s `session` prop
 * rather than through a hook in the product. `use` is serialized: it reaches only its two arguments.
 */
export async function onAdapter<R,A=void>(page:Page,use:(adapter:TerminalAdapter,arg:A)=>R|Promise<R>,arg?:A):Promise<R> {
  const adapter=await page.evaluateHandle(()=>{
    type Fiber={memoizedProps?:{session?:{adapter?:unknown}}|null;return:Fiber|null};
    const canvas=[...document.querySelectorAll('.terminal-canvas')].find(node=>node.getClientRects().length>0);
    const key=canvas&&Object.keys(canvas).find(name=>name.startsWith('__reactFiber$'));
    for(let fiber=key?Reflect.get(canvas,key) as Fiber|null:null;fiber;fiber=fiber.return)if(fiber.memoizedProps?.session?.adapter)return fiber.memoizedProps.session.adapter as TerminalAdapter;
    throw new Error('No terminal is drawn on this page.');
  });
  try{return await adapter.evaluate(use as never,arg) as R;}finally{await adapter.dispose();}
}

/** Waits until the terminal on screen has a drawn screen to measure. */
export const terminalDrawn=(page:Page)=>expect.poll(()=>onAdapter(page,adapter=>{const bounds=adapter.screenBounds();return !!bounds&&bounds.width>0&&bounds.height>0;}).catch(()=>false)).toBe(true);

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
