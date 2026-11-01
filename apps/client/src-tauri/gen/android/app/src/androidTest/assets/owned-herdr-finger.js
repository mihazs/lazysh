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
  const terminal=screen.parentElement,surface=terminal?.querySelector('.xterm-viewport'),textarea=terminal?.querySelector('.xterm-helper-textarea');
  const globalEvents=['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','touchstart','touchmove','touchend','touchcancel'];
  const trace=[],began=performance.now();
  let traceAvailable=true,overflow=false,pointerIdentity=null,touchIdentity=null;
  const bounded=value=>Number.isFinite(value)?Math.max(-65535,Math.min(65535,value)):null;
  const targetKind=target=>target==null?'none':target===textarea?'textarea':target===surface?'viewport':
    target===screen || screen.contains?.(target)?'screen':target===canvas?'canvas':target===terminal?'terminal':'other';
  const globalRecord=event=>{
    try {
      if(trace.length===24){overflow=true;return;}
      const touch=event.type.startsWith('touch'),point=touch?(event.changedTouches?.[0]??event.touches?.[0]):event;
      if(event.type==='pointerdown' && canvas.contains(event.target))pointerIdentity=event.pointerId;
      if(event.type==='touchstart' && canvas.contains(event.target))touchIdentity=point?.identifier;
      trace.push({type:globalEvents.includes(event.type)?event.type:'other',target:targetKind(event.target),trusted:event.isTrusted===true,
        cancelable:event.cancelable===true,defaultPrevented:event.defaultPrevented===true,
        phase:Number.isInteger(event.eventPhase)&&event.eventPhase>=0&&event.eventPhase<=3?event.eventPhase:-1,
        atMs:Math.max(0,Math.min(65535,performance.now()-began)),point:[bounded(point?.clientX),bounded(point?.clientY)],
        identityMatches:touch?touchIdentity!=null&&point?.identifier===touchIdentity:pointerIdentity!=null&&event.pointerId===pointerIdentity,
        coalescedCount:typeof event.getCoalescedEvents==='function'?Math.min(8,event.getCoalescedEvents().length):-1});
    } catch {traceAvailable=false;}
  };
  globalEvents.forEach(type=>window.addEventListener(type,globalRecord,{capture:true,passive:true}));
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
        held:starts===1 && moves>0,moves:Math.min(2,moves),wheels,wheelUp,wheelDown,wheelZero,wheelInvalid,global:{state:traceAvailable?'observed':'unavailable',overflow,events:trace.slice()}};
    },dispose:()=>{events.forEach(type=>canvas.removeEventListener(type,record,true));canvas.removeEventListener('wheel',wheel,true);globalEvents.forEach(type=>window.removeEventListener(type,globalRecord,true));}}});
  return true;
}
