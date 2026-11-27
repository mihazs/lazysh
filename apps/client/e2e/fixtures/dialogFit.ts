import {expect,type Page} from '@playwright/test';

/** The open dialog neither scrolls sideways nor leaves the viewport, as on a phone. */
export async function fitsWidth(page:Page) {
  const size=await page.getByRole('dialog').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth,viewport:window.innerWidth,right:node.getBoundingClientRect().right}));
  expect(size.scroll,JSON.stringify(size)).toBeLessThanOrEqual(size.width);
  expect(size.right,JSON.stringify(size)).toBeLessThanOrEqual(size.viewport);
}
