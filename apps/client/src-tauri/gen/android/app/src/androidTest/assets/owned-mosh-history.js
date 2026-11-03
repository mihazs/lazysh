// Pinned xterm5.5 DOM renderer/Viewport geometry only; never inspect its model.
function ownedMoshHistory(root) {
  const unavailable={valid:false,rows:null,historyRows:null};
  if(!root?.isConnected||!root.getClientRects().length||getComputedStyle(root).visibility!=='visible')return unavailable;
  const viewport=root.querySelector('.xterm-viewport'),area=root.querySelector('.xterm-scroll-area'),screen=root.querySelector('.xterm-screen');
  const lines=Array.from(root.querySelectorAll('.xterm-rows > div'));
  if(!viewport||!area||!screen||!lines.length||lines.length>256)return unavailable;
  const px=(value)=>/^[0-9]+(?:\.[0-9]+)?px$/.test(value)?Number.parseFloat(value):NaN;
  const row=px(lines[0].style.height),height=px(screen.style.height),scroll=px(area.style.height),dpr=window.devicePixelRatio;
  if(![row,height,scroll,dpr].every(value=>Number.isFinite(value)&&value>0)||dpr>8||viewport.offsetHeight<=0
    ||lines.some(line=>line.style.height!==lines[0].style.height)||Math.abs(row*lines.length-height)>0.001)return unavailable;
  // DOM rows divide a rounded canvas height; Viewport uses device-cell/DPR.
  // Accept only one device-pixel cell size consistent with that public rounding.
  const deviceCell=Math.round(row*dpr),canvas=(cell)=>Math.round(cell*lines.length/dpr);
  if(deviceCell<1||canvas(deviceCell)!==height||canvas(deviceCell-1)===height||canvas(deviceCell+1)===height)return unavailable;
  const cell=deviceCell/dpr,total=scroll-viewport.offsetHeight+height,bufferRows=Math.round(total/cell);
  if(!Number.isSafeInteger(bufferRows)||bufferRows<lines.length||bufferRows>65536||Math.round(cell*bufferRows)!==total
    ||Math.round(cell*(bufferRows-1))===total||Math.round(cell*(bufferRows+1))===total)return unavailable;
  return {valid:true,rows:lines.length,historyRows:bufferRows-lines.length};
}

