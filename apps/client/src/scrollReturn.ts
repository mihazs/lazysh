/** Scroll offset of the nearest scrolling ancestor, or of the window when none scrolls. */
export type ScrollPosition={scroller:HTMLElement|null;top:number};

export function captureScrollPosition(element:HTMLElement|null|undefined):ScrollPosition {
  let scroller=element?.parentElement??null;
  while(scroller && (!/^(auto|scroll)$/.test(getComputedStyle(scroller).overflowY) || scroller.scrollHeight<=scroller.clientHeight))scroller=scroller.parentElement;
  return {scroller,top:scroller?.scrollTop??window.scrollY};
}

/** Restores a captured offset (or `top`), skipping a scroller that has left the document. */
export function restoreScrollPosition(saved:ScrollPosition,top=saved.top) {
  if(!saved.scroller)window.scrollTo(window.scrollX,top);
  else if(saved.scroller.isConnected)saved.scroller.scrollTop=top;
}
