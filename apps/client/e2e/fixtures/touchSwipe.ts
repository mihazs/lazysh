import type {Page} from '@playwright/test';

/** One finger from `from` to `to` in CSS pixels, as the screen sends it: a touch start, paced moves, a touch end. */
export async function swipe(page:Page,from:[number,number],to:[number,number],{steps=12,release=true}:{steps?:number;release?:boolean}={}) {
  const touch=await page.context().newCDPSession(page);
  const at=(step:number)=>({x:from[0]+(to[0]-from[0])*step/steps,y:from[1]+(to[1]-from[1])*step/steps,id:1});
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[at(0)]});
  for(let step=1;step<=steps;step++){
    await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[at(step)]});
    await page.waitForTimeout(16);
  }
  if(release)await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await touch.detach();
}
