import {expect,test,type Page} from '@playwright/test';
import {connectAttachmentTerminal} from './fixtures/attachmentTerminal';

test.beforeEach(async({page})=>{
  await connectAttachmentTerminal(page,{nonce:'c'.repeat(64),ready:'\x1b[?2004lcomposer-ready'});
  await expect(page.locator('.xterm-screen')).toContainText('composer-ready');
});
const steps=()=>window.attachmentTerminal.writes.map(write=>write.steps??[write.data]);

const editor=(page:Page)=>page.getByRole('textbox',{name:'Compose text',exact:true});

async function attachFromComposer(page:Page,file:{name:string;mimeType:string;buffer:Buffer}) {
  await page.locator('.terminal-composer-sheet').getByRole('button',{name:'Attach',exact:true}).click();
  await page.getByLabel('Choose attachment',{exact:true}).setInputFiles(file);
  await page.getByRole('button',{name:'Upload attachment',exact:true}).click();
  // A composer-originated upload offers the draft, not a direct terminal paste.
  await expect(page.getByRole('button',{name:'Paste uploaded path',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Add to the terminal draft',exact:true}).click();
  await expect(editor(page)).toBeVisible();
}
// One decodable pixel, so the chip preview shows the uploaded image itself.
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const png=(name:string)=>({name,mimeType:'image/png',buffer:Buffer.from(pixel,'base64')});

test('attached images become numbered inline chips that delete atomically and expand to the uploaded paths on send',async({page},testInfo)=>{
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await editor(page).fill('compare');
  await attachFromComposer(page,png('before.png'));
  await attachFromComposer(page,png('after.png'));
  await attachFromComposer(page,{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('notes')});
  await expect(editor(page)).toHaveValue('compare [Image #1] [Image #2] [File #3] ');
  await expect(editor(page)).toBeFocused();
  const chips=page.getByRole('list',{name:'Draft attachments',exact:true});
  await expect(chips.getByRole('button')).toHaveText(['[Image #1]','','[Image #2]','','[File #3]','']);
  for(const label of ['Image #1: before.png. Show preview','Image #2: after.png. Show preview','File #3: notes.txt. Show preview'])
    await expect(chips.getByRole('button',{name:label,exact:true})).toBeVisible();
  // Each token is highlighted in place, under its own text in the editor.
  const marks=page.locator('.terminal-composer-mirror mark');
  await expect(marks).toHaveText(['[Image #1]','[Image #2]','[File #3]']);
  const box=await editor(page).boundingBox(),mark=await marks.first().boundingBox();
  expect(mark!.x).toBeGreaterThan(box!.x);expect(mark!.y).toBeGreaterThan(box!.y);expect(mark!.x+mark!.width).toBeLessThan(box!.x+box!.width);
  // A tap on a chip previews the image with the path the upload returned.
  await chips.getByRole('button',{name:'Image #2: after.png. Show preview',exact:true}).click();
  const preview=page.getByRole('figure',{name:'Preview of Image #2',exact:true});
  await expect(preview).toContainText("'/tmp/lazysh/after.png'");
  await expect(preview.getByRole('img',{name:'Preview of Image #2',exact:true})).toHaveJSProperty('naturalWidth',1);
  await page.screenshot({path:testInfo.outputPath('composer-attachment-tokens.png'),animations:'disabled'});
  // Backspace right after a token removes the whole token and its attachment.
  await editor(page).evaluate((element:HTMLTextAreaElement)=>{const end=element.value.indexOf('[File #3]')+'[File #3]'.length;element.focus();element.setSelectionRange(end,end);});
  await editor(page).press('Backspace');
  await expect(editor(page)).toHaveValue('compare [Image #1] [Image #2]  ');
  await expect(chips.getByRole('button',{name:'Remove File #3',exact:true})).toHaveCount(0);
  await expect(page.getByRole('status').filter({hasText:'File #3 removed from the draft'})).toHaveCount(1);
  expect(await page.evaluate(steps)).toEqual([]);
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>page.evaluate(steps)).toEqual([["compare '/tmp/lazysh/before.png' '/tmp/lazysh/after.png'  ",'\r']]);
  expect(await page.evaluate(()=>window.attachmentTerminal.uploads)).toEqual(['./before.png','./after.png','./notes.txt']);
  // The next draft numbers its attachments from one again.
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await attachFromComposer(page,png('again.png'));
  await expect(editor(page)).toHaveValue('[Image #1] ');
});

test('the chip remove control releases its attachment',async({page})=>{
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await attachFromComposer(page,png('shot.png'));
  await page.getByRole('button',{name:'Remove Image #1',exact:true}).click();
  await expect(editor(page)).toHaveValue('');
  await expect(page.getByRole('list',{name:'Draft attachments',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
});
