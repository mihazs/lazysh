import type {Page,TestInfo} from '@playwright/test';
export type Point={x:number;y:number};

/** Real browser touch input; the desktop project emulates a touch screen for the same gestures. */
export async function touchscreen(page:Page,testInfo:TestInfo) {
  const cdp=await page.context().newCDPSession(page);
  if(testInfo.project.name==='desktop')await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const send=(type:'touchStart'|'touchMove'|'touchEnd',points:Point[])=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((point,id)=>({...point,id}))});
  /** Moves every finger from its start to its end in even steps, then lifts them all. */
  const gesture=async(from:Point[],to:Point[],steps=8)=>{
    await send('touchStart',from);
    for(let step=1;step<=steps;step++)await send('touchMove',from.map((point,index)=>({x:point.x+(to[index].x-point.x)*step/steps,y:point.y+(to[index].y-point.y)*step/steps})));
    await send('touchEnd',[]);
  };
  return {cdp,send,gesture};
}
