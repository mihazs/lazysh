import type {Page} from '@playwright/test';

/** The soft keyboard opening over a window that does not resize: only the visual viewport loses `drop` pixels of height. */
export const shrinkVisualViewport=(page:Page,drop:number)=>page.evaluate(drop=>{
  const viewport=window.visualViewport!;
  Object.defineProperty(viewport,'height',{configurable:true,value:viewport.height-drop});
  viewport.dispatchEvent(new Event('resize'));
},drop);
