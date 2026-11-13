import type {Page} from '@playwright/test';

/** Shows the toolbar page (0 keys, 1 Find and Copy, 2 snippets and chords) through its page indicator, the non-gesture way. The dots are hidden (and take no touches) until the page changes, so the button is activated without a pointer. */
export async function showToolbarPage(page:Page,index:number) {
  await page.getByLabel('Terminal keys',{exact:true}).getByRole('group',{name:'Toolbar pages',exact:true}).getByRole('button').nth(index).evaluate(node=>(node as HTMLElement).click());
}

/** Presses one key that sits on a page after the keys (Find, Copy, a saved snippet or chord): the page opens first, as a user would. */
export async function pressMore(page:Page,name:string) {
  const keys=page.getByLabel('Terminal keys',{exact:true});
  const panel=keys.locator('.terminal-keys-page').filter({has:page.getByRole('button',{name,exact:true})});
  const id=await panel.getAttribute('data-toolbar-page');
  await showToolbarPage(page,{keys:0,tools:1,snippets:2}[id as 'keys']);
  await panel.getByRole('button',{name,exact:true}).click();
}
