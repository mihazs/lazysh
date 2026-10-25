import type { Page } from '@playwright/test';
export async function openFollowTranscript(page: Page) {
  await page.evaluate(async () => {
    const {mountChatFollowHarness}=await import('/e2e/fixtures/ChatFollowHarness.tsx');
    window.chatFollow=mountChatFollowHarness();
  });
  await page.getByLabel('Transcript path',{exact:true}).fill('/fixture/claude.jsonl');
  await page.getByRole('combobox',{name:'View',exact:true}).selectOption('conversation');
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
}
