import type {Page} from '@playwright/test';
declare global {interface Window {keyboardRequests:string[]}}

/**
 * Records every editable control that received focus. A touch screen raises the soft keyboard
 * for exactly those, so a navigation that briefly focuses the terminal cannot hide behind a later blur.
 */
export async function trackKeyboardRequests(page:Page) {
  await page.addInitScript(()=>{
    window.keyboardRequests=[];
    document.addEventListener('focusin',event=>{
      const node=event.target as HTMLElement;
      if(node.matches('input,textarea,select,[contenteditable]'))window.keyboardRequests.push(node.getAttribute('aria-label')??node.tagName);
    },true);
  });
}
export const keyboardRequests=(page:Page)=>page.evaluate(()=>window.keyboardRequests);
export const forgetKeyboardRequests=(page:Page)=>page.evaluate(()=>{window.keyboardRequests.length=0;});
