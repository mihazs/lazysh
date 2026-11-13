import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

// A Gemini CLI conversation as the host companion reads it (apps/agent/tests/gemini_conversation.rs builds the same shapes).
const plan={kind:'plan',entries:[{text:'Write the reader',status:'completed'},{text:'Test it',status:'in_progress'},{text:'Ship it',status:'blocked'}]};
const messages=[
  {id:'u1',role:'user',blocks:[{type:'text',text:'Build the Gemini reader'}]},
  {id:'g1',role:'assistant',blocks:[
    {type:'tool_use',id:'todo',name:'write_todos',text:'{}',card:plan},
    {type:'tool_use',id:'search',name:'google_web_search',text:'{"query":"gemini cli sessions"}'},
    {type:'tool_use',id:'edit',name:'replace',text:JSON.stringify({file_path:'src/lib.rs',instruction:'rename',old_string:'old();',new_string:'fresh();\nextra();'})},
  ]},
  {id:'g1:results',role:'tool',blocks:[{type:'tool_result',id:'search',text:'three results',isError:false},{type:'tool_result',id:'edit',text:'Successfully modified file: src/lib.rs',isError:false}]},
  {id:'g2',role:'assistant',blocks:[{type:'text',text:'The reader is done.'}]},
];
const work=[
  {id:'sub',kind:'agent',title:'codebase_investigator',subtitle:'Map the repo',state:'running',events:[]},
  {id:'bg',kind:'shell',title:'Dev server',command:'npm run dev',state:'running',events:[]},
];

test('a Gemini CLI conversation shows its plan, its sub-agent and its background shell like Claude Code, inside the viewport',async({page})=>{
  await openAgentWork(page,messages,{work,session:{model:'gemini-3-pro'}},{},'gemini');
  await expect(page.getByText('The reader is done.')).toBeVisible();
  // Gemini's `blocked` is a step of the plan, shown as such.
  const chip=page.getByRole('button',{name:/1 of 3/});
  await expect(chip).toBeVisible();
  await chip.click();
  const list=page.getByRole('region',{name:'Plan',exact:true});
  await expect(list.getByRole('listitem')).toHaveCount(3);
  const panel=page.getByRole('region',{name:'Background work',exact:true});
  await expect(panel).toContainText('2 running');
  await expect(panel).toContainText('1 shell');
  // Gemini's `replace` is a diff card like Claude Code's Edit; nothing is reported as broken.
  await page.locator('.agent-turn-activity > summary').click();
  const edit=page.locator('.agent-tool[data-kind="diff"]');
  await expect(edit).toHaveCount(1);
  await expect(edit.locator('summary')).toContainText('src/lib.rs');
  await expect(edit.locator('.agent-diff-counts').first()).toHaveAttribute('aria-label','2 lines added, 1 removed');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const viewport=page.viewportSize()!;
  for(const region of [list,panel]){
    const box=(await region.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);
  }
});
