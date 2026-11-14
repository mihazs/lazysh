import type {Page} from '@playwright/test';
import type {mountAgentWorkHarness} from './AgentWorkHarness';
declare global {interface Window {agentWork:ReturnType<typeof mountAgentWorkHarness>}}

/** Opens the Agent view's timeline reader on a synthetic conversation of `agent` (Claude Code unless told otherwise) made of `messages`; `extra` adds page fields such as `work`; `children` maps a transcript path to the messages of that conversation. */
export async function openAgentWork(page: Page, messages: unknown[], extra: Record<string, unknown> = {}, children: Record<string, unknown[]> = {}, agent: 'claude' | 'gemini' = 'claude') {
  await page.goto('/');
  await page.evaluate(([messages, extra, children, agent]) => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {invoke: async (_command: string, args: {path?: string}) => (args.path && children[args.path]
      ? {schemaVersion: 1, agent, view: 'active_branch', messages: children[args.path], nextOffset: 1, hasMore: false}
      : {schemaVersion: 1, agent, view: 'active_branch', messages, nextOffset: 1, hasMore: false, ...extra})}});
  }, [messages, extra, children, agent] as const);
  await page.evaluate(async agent => {
    const {mountAgentWorkHarness} = await import('/e2e/fixtures/AgentWorkHarness.tsx');
    window.agentWork = mountAgentWorkHarness(agent);
  }, agent);
}
