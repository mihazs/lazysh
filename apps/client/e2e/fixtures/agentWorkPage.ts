import type {Page} from '@playwright/test';
import type {mountAgentWorkHarness} from './AgentWorkHarness';
declare global {interface Window {agentWork:ReturnType<typeof mountAgentWorkHarness>}}

/** Opens the Agent view's timeline reader on a synthetic Claude conversation made of `messages`; `extra` adds page fields such as `work`. */
export async function openAgentWork(page: Page, messages: unknown[], extra: Record<string, unknown> = {}) {
  await page.goto('/');
  await page.evaluate(([messages, extra]) => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {invoke: async () => ({schemaVersion: 1, agent: 'claude', view: 'active_branch', messages, nextOffset: 1, hasMore: false, ...extra})}});
  }, [messages, extra] as const);
  await page.evaluate(async () => {
    const {mountAgentWorkHarness} = await import('/e2e/fixtures/AgentWorkHarness.tsx');
    window.agentWork = mountAgentWorkHarness();
  });
}
