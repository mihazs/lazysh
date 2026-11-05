import {expect,test,type Page} from '@playwright/test';
import {openFollowTranscript} from './fixtures/chatTranscript';
import type {mountChatFollowHarness} from './fixtures/ChatFollowHarness';
import {interactionPages as pages} from './fixtures/interactionPages';
declare global {interface Window {
  chatFollow:ReturnType<typeof mountChatFollowHarness>;
  interactionFixture:{responses:unknown[];calls:number};
}}

async function fixture(page:Page,responses:unknown[],agent:'claude'|'opencode') {
  await page.goto('/');
  await page.evaluate(responses=>{
    window.interactionFixture={responses,calls:0};
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string)=>{
      if(command!=='agent_transcript')throw new Error('Unexpected fixture command');
      const f=window.interactionFixture;
      return f.responses[Math.min(f.calls++,f.responses.length-1)];
    }}});
  },responses);
  await openFollowTranscript(page,agent);
}
async function fitsViewport(page:Page,region:ReturnType<Page['getByRole']>) {
  const box=await region.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test('a Claude question waits for a terminal answer, then the refreshed branch shows the answer and idle state',async({page})=>{
  await fixture(page,[pages.claudeWaiting,pages.claudeIdle],'claude');
  const status=page.locator('.chat-activity');
  await expect(status).toContainText('Agent is waiting for your answer');
  const plan=page.getByRole('region',{name:'Plan',exact:true});
  await expect(plan.getByRole('listitem')).toHaveText(['DoneRecord the fixture shapes','In progressChoose a layout','PendingWrite the reader tests']);
  const question=page.getByRole('region',{name:'Question',exact:true});
  await expect(question.getByRole('group',{name:'Layout: Which fixture layout should the reader use?'})).toBeVisible();
  await expect(question.getByRole('listitem')).toHaveText(['FlatOne records file per agent.','NestedOne directory per agent.']);
  await expect(question.getByRole('note')).toHaveText("No answer is recorded yet. Answer in the terminal: Chat cannot choose options in the agent's prompt.");
  await expect(question.getByRole('radio')).toHaveCount(0);
  await fitsViewport(page,question);
  await fitsViewport(page,plan);

  await page.getByRole('button',{name:'Refresh new messages',exact:true}).click();
  await expect(status).toContainText('Agent is idle');
  await expect(question.getByRole('note')).toContainText('An answer is recorded.');
  const proposed=page.getByRole('region',{name:'Proposed plan',exact:true});
  await expect(proposed.getByRole('heading',{name:'Fixture plan'})).toBeVisible();
  await fitsViewport(page,proposed);
});

test('OpenCode todos keep cancelled entries and multiple-choice questions',async({page})=>{
  // The harness selects OpenCode session "selected"; the page must name the same branch.
  await fixture(page,[{...pages.opencodeIdle,branchId:'selected'}],'opencode');
  await expect(page.locator('.chat-activity')).toContainText('Agent is idle');
  await expect(page.getByRole('region',{name:'Plan',exact:true}).getByRole('listitem')).toHaveText(['DoneRecord the fixture shapes','In progressChoose a layout','CancelledDrop the legacy layout']);
  await expect(page.getByRole('region',{name:'Question',exact:true})).toContainText('More than one option can be chosen.');
});
