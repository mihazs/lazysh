function ownedHerdrSwipeGeometry(screens, viewport, density, document) {
  const bounded=value=>Number.isFinite(value)?Math.max(-65535,Math.min(65535,value)):-1;
  const diagnostic={stage:'screen-count',screenCount:Math.min(8,screens.length),hasViewport:!!viewport,
    scale:viewport?bounded(viewport.scale):-1,density:bounded(density)};
  const unavailable=stage=>({ready:false,hits:['none','none','none'],diagnostic:{...diagnostic,stage}});
  if(screens.length!==1)return unavailable('screen-count');
  if(!viewport)return unavailable('viewport');
  diagnostic.viewport=[viewport.offsetLeft,viewport.offsetTop,viewport.width,viewport.height].map(bounded);
  if(viewport.scale!==1)return unavailable('scale');
  const screen=screens[0],terminal=screen.parentElement,canvas=screen.closest('.terminal-canvas');
  diagnostic.hasTerminal=!!terminal;
  diagnostic.xterm=!!terminal?.classList.contains('xterm');
  diagnostic.hasCanvas=!!canvas;
  diagnostic.directParent=!!terminal && terminal.parentElement===canvas;
  if(!diagnostic.xterm || !canvas || !diagnostic.directParent)return unavailable('structure');
  const surfaces=terminal.querySelectorAll(':scope > .xterm-viewport');
  diagnostic.surfaceCount=Math.min(8,surfaces.length);
  if(surfaces.length!==1)return unavailable('surface-count');
  diagnostic.surfaceVisible=surfaces[0].getClientRects().length>0 && getComputedStyle(surfaces[0]).visibility!=='hidden';
  if(!diagnostic.surfaceVisible)return unavailable('surface-hidden');
  const surface=surfaces[0],r=screen.getBoundingClientRect(),s=surface.getBoundingClientRect();
  const inside=b=>[b.left,b.top,b.right,b.bottom].every(Number.isFinite) && b.width>0 && b.height>0 &&
    b.left>=viewport.offsetLeft && b.top>=viewport.offsetTop &&
    b.right<=viewport.offsetLeft+viewport.width && b.bottom<=viewport.offsetTop+viewport.height;
  const hits=[0.25,0.5,0.75].map(fraction=>{
    const hit=document.elementFromPoint((r.left+r.right)/2,r.top+r.height*fraction);
    return !hit?'none':hit===screen || screen.contains(hit)?'screen':hit===surface?'viewport':'other';
  });
  diagnostic.screenRect=[r.left,r.top,r.right,r.bottom].map(bounded);
  diagnostic.surfaceRect=[s.left,s.top,s.right,s.bottom].map(bounded);
  diagnostic.screenInside=inside(r);diagnostic.surfaceInside=inside(s);diagnostic.hits=hits;
  const ready=inside(r) && inside(s) && hits.every(hit=>hit==='screen' || hit==='viewport');
  diagnostic.stage=!inside(r)||!inside(s)?'bounds':ready?'ready':'hits';
  return {ready,hits,diagnostic,rect:[r.left,r.top,r.right,r.bottom],
    viewport:[viewport.offsetLeft,viewport.offsetTop,viewport.width,viewport.height,viewport.scale],density};
}

function ownedHerdrObserveFinger(window, key, screens) {
  if(Object.hasOwn(window,key) || screens.length!==1) return false;
  const screen=screens[0],canvas=screen.closest('.terminal-canvas');
  if(!canvas) return false;
  let starts=0,moves=0,ends=0,cancels=0,identifier=null,valid=true;
  let wheels=0,wheelUp=0,wheelDown=0,wheelZero=0,wheelInvalid=0;
  const wheel=event=>{
    wheels=Math.min(64,wheels+1);
    if(!Number.isFinite(event.deltaY))wheelInvalid=Math.min(64,wheelInvalid+1);
    else if(event.deltaY<0)wheelUp=Math.min(64,wheelUp+1);
    else if(event.deltaY>0)wheelDown=Math.min(64,wheelDown+1);
    else wheelZero=Math.min(64,wheelZero+1);
  };
  const record=event=>{
    valid=valid && event.isTrusted && canvas.contains(event.target);
    if(event.type==='touchstart') {
      starts++;valid=valid && starts===1 && event.touches.length===1;
      identifier=event.touches[0]?.identifier;
    } else if(event.type==='touchmove') {
      moves++;valid=valid && event.touches.length===1 && event.touches[0].identifier===identifier;
    } else if(event.type==='touchend')ends++;else cancels++;
  };
  const events=['touchstart','touchmove','touchend','touchcancel'];
  events.forEach(type=>canvas.addEventListener(type,record,{capture:true,passive:true}));
  canvas.addEventListener('wheel',wheel,{capture:true,passive:true});
  Object.defineProperty(window,key,{configurable:true,value:{
    sample:()=>{
      const match=screen.textContent.match(/OLD([0-9]{3})/);
      return {row:match?Number(match[1]):-1,newest:screen.textContent.includes('NEW512'),
        active:screen.isConnected && valid && starts<=1 && ends===0 && cancels===0,
        held:starts===1 && moves>0,moves:Math.min(2,moves),wheels,wheelUp,wheelDown,wheelZero,wheelInvalid};
    },dispose:()=>{events.forEach(type=>canvas.removeEventListener(type,record,true));canvas.removeEventListener('wheel',wheel,true);}}});
  return true;
}
