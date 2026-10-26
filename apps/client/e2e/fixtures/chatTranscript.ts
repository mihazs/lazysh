import type { Page } from '@playwright/test';
export async function openFollowTranscript(page: Page, agent: 'claude' | 'grok-acp' = 'claude') {
  await page.evaluate(async () => {
    const {mountChatFollowHarness}=await import('/e2e/fixtures/ChatFollowHarness.tsx');
    window.chatFollow=mountChatFollowHarness();
  });
  if (agent === 'grok-acp') await page.getByRole('combobox',{name:'Agent',exact:true}).selectOption(agent);
  await page.getByLabel('Transcript path',{exact:true}).fill(agent === 'claude' ? '/fixture/claude.jsonl' : '/fixture/updates.jsonl');
  if (agent === 'claude') await page.getByRole('combobox',{name:'View',exact:true}).selectOption('conversation');
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
}
