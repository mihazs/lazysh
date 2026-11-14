import type {Page} from '@playwright/test';
import type {mountAgentWorkHarness} from './AgentWorkHarness';
declare global {interface Window {agentWork:ReturnType<typeof mountAgentWorkHarness>}}

/** Opens the Agent view's timeline reader on a synthetic Claude conversation made of `messages`; `extra` adds page fields such as `work`; `children` maps a transcript path to the messages of that conversation. */
export async function openAgentWork(page: Page, messages: unknown[], extra: Record<string, unknown> = {}, children: Record<string, unknown[]> = {}) {
  await page.goto('/');
  await page.evaluate(([messages, extra, children]) => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {invoke: async (_command: string, args: {path?: string}) => (args.path && children[args.path]
      ? {schemaVersion: 1, agent: 'claude', view: 'active_branch', messages: children[args.path], nextOffset: 1, hasMore: false}
      : {schemaVersion: 1, agent: 'claude', view: 'active_branch', messages, nextOffset: 1, hasMore: false, ...extra})}});
  }, [messages, extra, children] as const);
  await page.evaluate(async () => {
    const {mountAgentWorkHarness} = await import('/e2e/fixtures/AgentWorkHarness.tsx');
    window.agentWork = mountAgentWorkHarness();
  });
}
