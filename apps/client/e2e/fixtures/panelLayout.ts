import {expect,type Locator} from '@playwright/test';

export async function expectPanelInsets(panel:Locator) {
  expect(await panel.evaluate(element=>{
    const parent=element.getBoundingClientRect();
    const introductions=Array.from(element.querySelectorAll(':scope > h2, :scope > h3, :scope > p'));
    return introductions.length>0 && introductions.every(child=>{
      const bounds=child.getBoundingClientRect();
      return bounds.left-parent.left>=16 && parent.right-bounds.right>=16;
    });
  })).toBe(true);
}
