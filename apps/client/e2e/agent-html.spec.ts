import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const wide=`<table><thead><tr>${Array.from({length:12},(_,index)=>`<th>Column ${index}</th>`).join('')}</tr></thead><tbody><tr>${Array.from({length:12},(_,index)=>`<td>${'a very long cell value '.repeat(3)}${index}</td>`).join('')}</tr></tbody></table>`;
const messages=[
  {id:'p',role:'user',blocks:[{type:'text',text:'Fix this:\n\n<div><b>pasted</b> <img src="https://tracker.invalid/x.png" alt="screenshot"> <script>window.__xss=1</script></div>'}]},
  {id:'a',role:'assistant',blocks:[{type:'text',text:`Result <kbd>Ctrl</kbd>+<kbd>C</kbd>\n\n${wide}\n\n<details><summary>Why</summary>See <a href="https://example.com/why">the docs</a>, not <a href="javascript:window.__xss=1">this</a>.</details>\n\n\`\`\`html\n<b>literal</b>\n\`\`\``}]},
];

test('HTML in a message renders inside the viewport: a wide table scrolls, remote images and scripts do not load, links ask first, code stays literal',async({page})=>{
  const requests:string[]=[];
  page.on('request',request=>{if(request.url().includes('tracker.invalid'))requests.push(request.url());});
  await openAgentWork(page,messages);
  const flow=page.locator('.chat-messages');
  const viewport=page.viewportSize()!;
  await expect(flow.getByText('pasted',{exact:true})).toBeVisible();
  await expect(flow.locator('script')).toHaveCount(0);
  await expect(flow.getByText('[Image — view in terminal]')).toBeVisible();
  expect(requests).toEqual([]);
  // A wide table scrolls inside its own region and never widens the page.
  const region=flow.getByRole('region',{name:'Table'});
  const box=(await region.boundingBox())!;
  expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);
  expect(await region.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  // Details open on tap; a link asks before it opens and the unsafe one is plain text.
  await flow.getByText('Why',{exact:true}).click();
  await expect(flow.getByRole('link',{name:'this'})).toHaveCount(0);
  await flow.getByRole('link',{name:'the docs'}).click();
  const consent=flow.getByRole('region',{name:'Open this address?'});
  await expect(consent).toContainText('https://example.com/why');
  const button=(await consent.getByRole('button',{name:'Open in browser'}).boundingBox())!;
  expect(button.height).toBeGreaterThanOrEqual(44);
  await consent.getByRole('button',{name:'Dismiss link'}).click();
  await expect(consent).toHaveCount(0);
  // Code fences stay literal; the source toggle shows the original text of the message.
  await expect(flow.locator('code.language-html')).toHaveText('<b>literal</b>\n');
  await flow.getByRole('button',{name:'Show source'}).nth(1).click();
  await expect(flow.locator('pre.chat-html-source')).toContainText('<details><summary>Why</summary>');
  expect(await page.evaluate(()=>(window as unknown as {__xss?:number}).__xss)).toBeUndefined();
});
