import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const output=Array.from({length:40},(_,index)=>`error[E${1000+index}]: something long happened in a file with a rather long path name to force wrapping on a phone`).join('\n');
const messages=[
  {id:'p',role:'user',blocks:[{type:'text',text:'Fix the build'}]},
  {id:'a1',role:'assistant',blocks:[{type:'tool_use',id:'t1',name:'Bash',text:JSON.stringify({command:'cargo build --workspace --all-targets'})}]},
  {id:'r1',role:'user',blocks:[{type:'tool_result',id:'t1',text:`Exit code 101\n${output}`,isError:true}]},
  {id:'a2',role:'assistant',blocks:[{type:'tool_use',id:'t2',name:'Edit',text:JSON.stringify({file_path:'src/lib.rs',old_string:'fn a() {\n    old();\n}',new_string:'fn a() {\n    new_one();\n    new_two();\n}'})}]},
  {id:'r2',role:'user',blocks:[{type:'tool_result',id:'t2',text:'The file src/lib.rs has been updated.'}]},
  {id:'a3',role:'assistant',blocks:[{type:'text',text:'Fixed the build.'}]},
];

test('a call and its result are one card: failing command with its output tail, and an edit as a diff, inside the viewport',async({page})=>{
  await openAgentWork(page,messages);
  await page.locator('.agent-turn-activity > summary').click();
  const cards=page.locator('.agent-tool');
  await expect(cards).toHaveCount(2);
  const [command,edit]=[cards.nth(0),cards.nth(1)];
  await expect(command).toHaveAttribute('data-status','error');
  await expect(command.locator('summary')).toContainText('cargo build --workspace --all-targets');
  await expect(command.locator('summary')).toContainText('exit code 101');
  await command.locator('summary').click();
  const tail=command.getByLabel('Output');
  await expect(tail).toContainText('E1039');
  await expect(tail).not.toContainText('E1000');
  await command.getByRole('button',{name:'Show 20 earlier lines'}).click();
  await expect(command.getByLabel('Output')).toContainText('E1000');

  await expect(edit).toHaveAttribute('data-kind','diff');
  await expect(edit.locator('summary')).toContainText('src/lib.rs');
  await expect(edit.locator('.agent-diff-counts').first()).toHaveAttribute('aria-label','2 lines added, 1 removed');
  await edit.locator('summary').click();
  await expect(edit.locator('.agent-diff-lines [data-kind="-"]')).toHaveText('-    old();');
  await expect(edit.locator('.agent-diff-lines [data-kind="+"]')).toHaveText(['+    new_one();','+    new_two();']);

  const viewport=page.viewportSize()!;
  for(const card of [command,edit]) {
    const box=(await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);
  }
  // The raw JSON block of the call is gone, and so is the separate result block.
  await expect(page.getByText('Recorded tool error')).toHaveCount(0);
  await expect(page.getByText('The file src/lib.rs has been updated.')).toHaveCount(0);
});
