import {expect,test,type Page} from '@playwright/test';
import type {mountFileTransfer} from './fixtures/FileTransferHarness';
import {transferName,transferSession} from '../src/test/fileTransferData';
declare global {interface Window {transfer:ReturnType<typeof mountFileTransfer>;}}

async function open(page:Page,stat:Parameters<typeof mountFileTransfer>[0]={},prepare:string|undefined=undefined) {
  await page.goto('/');
  await page.evaluate(async({stat,prepare})=>{
    const {mountFileTransfer}=await import('/e2e/fixtures/FileTransferHarness.tsx');
    window.transfer=mountFileTransfer(stat);
    if(prepare==='hold')window.transfer.holdDownloads();
  },{stat,prepare});
  const files=page.getByRole('region',{name:'Remote files',exact:true});
  await files.getByRole('button',{name:new RegExp(transferName)}).click();
  await expect(files.getByRole('group',{name:'File actions'})).toBeVisible();
  return files;
}
const calls=(page:Page,...commands:string[])=>page.evaluate(commands=>window.transfer.calls.filter(call=>commands.includes(call.command)),commands);

test('Download copies the selected file with progress and reports where it was saved',async({page})=>{
  const files=await open(page,{},'hold');
  await files.getByRole('button',{name:'Download',exact:true}).click();
  await expect(files.getByRole('status').filter({hasText:'Downloading'})).toBeVisible();
  await page.evaluate(()=>window.transfer.progress(1_250_000,2_500_000));
  await expect(files.getByRole('progressbar',{name:'Download progress'})).toHaveJSProperty('value',1_250_000);
  await expect(files.getByText(`Downloading ${transferName}: 1.2 MiB of 2.4 MiB`)).toBeVisible();
  for(const name of ['Download','Open with…'])await expect(files.getByRole('button',{name,exact:true})).toBeDisabled();
  expect(await files.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('transfer-progress.png')});
  await page.evaluate(()=>window.transfer.finish());
  await expect(files.getByText(`Saved to /home/zoë/Downloads/${transferName}.`)).toBeVisible();
  const [download,deliver,...rest]=await calls(page,'host_file_download','host_file_deliver','host_file_cancel');
  expect(download.args).toMatchObject({sessionId:transferSession,path:`./${transferName}`,followLink:false,allowLarge:false});
  expect(deliver.args).toMatchObject({sessionId:transferSession,transferId:download.args.transferId,action:'save'});
  expect(rest.map(call=>call.args.transferId)).toEqual([download.args.transferId]);
});

test('Cancel stops the transfer on the host side and keeps nothing',async({page})=>{
  const files=await open(page,{},'hold');
  await files.getByRole('button',{name:'Download',exact:true}).click();
  await files.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(files.getByRole('button',{name:'Stopping download…',exact:true})).toBeDisabled();
  const [download,cancel]=await calls(page,'host_file_download','host_file_cancel');
  expect(cancel.args).toMatchObject({sessionId:transferSession,transferId:download.args.transferId});
  await page.evaluate(()=>window.transfer.fail({kind:'transfer_cancelled',message:'Download cancelled. No file was kept.'}));
  await expect(files.getByText('Download cancelled. Nothing was kept.')).toBeVisible();
  expect(await calls(page,'host_file_deliver')).toEqual([]);
});

test('a large file or a symbolic link asks first, and Cancel starts nothing',async({page})=>{
  const files=await open(page,{size:300*1024*1024,link:'/srv/archive/real.pdf'});
  await files.getByRole('button',{name:'Download',exact:true}).click();
  const prompt=files.getByRole('group',{name:'Confirm download'});
  await expect(prompt).toContainText('is a symbolic link to /srv/archive/real.pdf');
  await expect(prompt).toContainText('is 300 MiB. Download it anyway?');
  await page.screenshot({path:test.info().outputPath('transfer-confirm.png')});
  await prompt.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(prompt).toHaveCount(0);
  expect(await calls(page,'host_file_download')).toEqual([]);
  await files.getByRole('button',{name:'Download',exact:true}).click();
  await prompt.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(files.getByText(`Saved to /home/zoë/Downloads/${transferName}.`)).toBeVisible();
  expect((await calls(page,'host_file_download'))[0].args).toMatchObject({followLink:true,allowLarge:true});
});

test('Open with hands the downloaded copy to another app and a refused type explains why',async({page})=>{
  const files=await open(page);
  await files.getByRole('button',{name:'Open with…',exact:true}).click();
  await expect(files.getByText('Opened in the app you chose.')).toBeVisible();
  expect((await calls(page,'host_file_deliver'))[0].args).toMatchObject({action:'open'});
  expect(await calls(page,'host_file_cancel')).toEqual([]);
  await page.evaluate(()=>window.transfer.failDelivery({kind:'open_refused',message:'lazysh does not open programs or scripts. Download the file instead.'}));
  await files.getByRole('button',{name:'Open with…',exact:true}).click();
  await expect(files.getByRole('alert')).toHaveText('lazysh does not open programs or scripts. Download the file instead.');
  expect((await calls(page,'host_file_cancel')).length).toBe(2);
});

test('Share appears only when the device reports it',async({page})=>{
  const files=await open(page,{actions:['save','open','share']});
  await files.getByRole('button',{name:'Share',exact:true}).click();
  await expect(files.getByText('Sent to the app you chose.')).toBeVisible();
  expect((await calls(page,'host_file_deliver'))[0].args).toMatchObject({action:'share'});
});
