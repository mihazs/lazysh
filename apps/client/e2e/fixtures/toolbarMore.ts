import type {Page} from '@playwright/test';

/** Opens the toolbar's More list (Find, Copy and the saved snippets and chords) unless it is already open. */
export async function openMore(page:Page) {
  const list=page.getByRole('group',{name:'More keys',exact:true});
  if(!await list.isVisible())await page.getByLabel('Terminal keys',{exact:true}).getByRole('button',{name:'More keys',exact:true}).click();
  return list;
}

/** Presses one entry of the More list; the list closes afterwards, so each press opens it again. */
export async function pressMore(page:Page,name:string) {
  await (await openMore(page)).getByRole('button',{name,exact:true}).click();
}
