/**
 * Runs inside the page (WebdriverIO `execute`, Playwright `evaluate`), so it must stay self-contained. Returns the viewport
 * points of a drag that selects exactly the terminal row reading `marker`: from inside its first cell to blank cells past
 * its end, which xterm trims from a single-row selection. The drag is for xterm's DOM renderer rows.
 */
export function markerDrag(marker:string) {
  const row=Array.from(document.querySelectorAll('.terminal-canvas .xterm-rows > div')).find(node=>(node.textContent??'').trim()===marker);
  const probe=document.querySelector('.terminal-canvas .xterm-char-measure-element');
  if(!row||!probe)return null;
  const box=row.getBoundingClientRect(),cell=probe.getBoundingClientRect().width/Math.max(1,(probe.textContent??'').length),y=box.top+box.height/2;
  return {from:{x:box.left+cell/4,y},to:{x:box.left+(marker.length+2)*cell,y}};
}
