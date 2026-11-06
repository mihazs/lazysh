import {workspaceControl} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';
import {connectAttachmentTerminal} from './fixtures/attachmentTerminal';
import {attachmentUploadedPath} from '../src/test/attachmentData';
const writes=()=>window.attachmentTerminal.writes.map(({sessionId,data,headers})=>({sessionId,data,headers}));

for(const scenario of [
  {name:'plain paste',bracketed:false,path:attachmentUploadedPath,valid:true},
  {name:'bracketed paste',bracketed:true,path:attachmentUploadedPath,valid:true},
  {name:'forged C1 control rejected',bracketed:true,path:'/host/unsafe\x9b201~path',valid:false},
])test(`actual App original attachment path: ${scenario.name}`,async({page})=>{
  const nonce='a'.repeat(64);
  await connectAttachmentTerminal(page,{nonce,uploadedPath:scenario.path,ready:(scenario.bracketed?'\x1b[?2004h':'\x1b[?2004l')+'paste-ready'});
  await expect(page.locator('.xterm-screen')).toContainText('paste-ready');
  await (await workspaceControl(page,'Attach')).click();
  await page.getByLabel('Choose attachment',{exact:true}).setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('literal upload bytes')});
  await page.getByRole('button',{name:'Upload attachment',exact:true}).click();
  await page.getByText('More attachment actions',{exact:true}).click();
  const prompt=page.getByRole('textbox',{name:'Editable prompt',exact:true});
  await prompt.fill('  keep this editable prompt unchanged  ');
  expect(await page.evaluate(writes)).toEqual([]);
  await page.getByRole('button',{name:'Paste uploaded path',exact:true}).click();
  const literal="'/sftp/home/actual {{path}}'\\''s <file>.png'";
  if(scenario.valid){
    await expect.poll(()=>page.evaluate(writes)).toEqual([{sessionId:'ssh:attachment-terminal',data:scenario.bracketed?`\x1b[200~${literal}\x1b[201~`:literal,headers:{'X-Lazysh-Access':nonce}}]);
    await expect(page.getByText('Path sent without Enter. Check the terminal before continuing.',{exact:true})).toBeVisible();
  }else{
    await expect(page.getByRole('alert')).toHaveText('The upload did not return a valid single-line absolute path for terminal paste.');
    expect(await page.evaluate(writes)).toEqual([]);
  }
  await expect(prompt).toHaveValue('  keep this editable prompt unchanged  ');
});
