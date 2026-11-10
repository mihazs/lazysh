import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {SshFixture} from '../../../tests/support/sshFixture';
import {herdrTools} from '../../../tests/support/androidHerdr';
import {NativeGui} from './fixture';
import {openOwnedSsh,ownedSshGui,workspaceAction} from './sshUi';

const fixture=ownedSshGui();

it('renders recorded Claude and Codex tool cards through owned SSH',async()=>{
  const ssh=fixture.ssh=await SshFixture.start(herdrTools());
  const claude=join(ssh.directory,'claude-cards.jsonl'),codex=join(ssh.directory,'codex-cards.jsonl');
  const claudeRows=[
    {type:'user',uuid:'root',message:{content:'Inspect the fixture'}},
    {type:'assistant',uuid:'edit',parentUuid:'root',message:{content:[{type:'tool_use',id:'edit-1',name:'Edit',input:{file_path:'claude.txt',old_string:'old',new_string:'new'}}]}},
    {type:'user',uuid:'edit-result',parentUuid:'edit',message:{content:[{type:'tool_result',tool_use_id:'edit-1',content:'updated'}]},toolUseResult:{filePath:'claude.txt',structuredPatch:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-old','+new']}]}},
    {type:'assistant',uuid:'run',parentUuid:'edit-result',message:{content:[{type:'tool_use',id:'run-1',name:'Bash',input:{command:'false'}}]}},
    {type:'user',uuid:'run-result',parentUuid:'run',message:{content:[{type:'tool_result',tool_use_id:'run-1',content:'Claude command failed',is_error:true}]}},
  ];
  const id='11111111-1111-4111-8111-111111111111';
  const codexRows=[
    {type:'session_meta',ordinal:0,payload:{id,history_mode:'paginated'}},
    {type:'event_msg',ordinal:1,payload:{type:'task_started',turn_id:'one'}},
    {type:'event_msg',ordinal:2,payload:{type:'item_completed',thread_id:id,turn_id:'one',item:{type:'FileChange',id:'edit',status:'completed',changes:{'codex.txt':{type:'update',unified_diff:'@@ -1 +1 @@\n-before\n+after'}}}}},
    {type:'event_msg',ordinal:3,payload:{type:'item_completed',thread_id:id,turn_id:'one',item:{type:'CommandExecution',id:'run',command:['false'],status:'failed',exit_code:1,aggregated_output:'Codex command failed'}}},
  ];
  for(const [path,rows] of [[claude,claudeRows],[codex,codexRows]] as const)await writeFile(path,rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600,flag:'wx'});
  const gui=fixture.gui=await NativeGui.start();
  const {browser}=await openOwnedSsh(gui,ssh);gui.stage='owned schema 2 tool cards';
  await workspaceAction(gui,'Transcript');
  const agent=await browser.$('//label[normalize-space(text())="Agent"]/select');
  for(const [provider,path,file,output] of [['codex',codex,'codex.txt','Codex command failed'],['claude',claude,'claude.txt','Claude command failed']] as const){
    await agent.selectByAttribute('value',provider);
    await (await browser.$('//label[normalize-space(text())="View"]/select')).selectByAttribute('value','conversation');
    await (await browser.$('input[placeholder="Absolute host path to session.jsonl"]')).setValue(path);
    await (await browser.$('button=Open transcript')).click();
    const edit=await browser.$(`//details[contains(@class,'agent-tool-card')]/summary[contains(.,'${file}')]`);await edit.waitForDisplayed({timeout:20_000});
    expect(await edit.getText()).toContain('+1 −1');await edit.click();
    const editText=await edit.parentElement().getText();expect(editText).toContain(provider==='claude'?'+new':'+after');
    const failure=await browser.$("//details[contains(@class,'agent-tool-card')]/summary[contains(.,'Failed')]");await failure.waitForDisplayed();await failure.click();
    const commandText=await failure.parentElement().getText();expect(commandText).toContain('false');expect(commandText).toContain(output);
    if(provider==='codex')expect(commandText).toContain('Exit code: 1');
  }
},180_000);
