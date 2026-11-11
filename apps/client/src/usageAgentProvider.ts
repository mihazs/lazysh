import type {AccountUsageEntry} from './accountUsageReport';

/** The 31 built-in providers of the account-usage collectors: report entry id (the collector's slug) and brand name. Custom providers are `custom:<id>`, named accounts `<slug>@<name>`. */
export const usageProviders = [
  ['anthropic','Claude'],['anthropic_api','Anthropic API'],['openai','Codex'],['copilot','GitHub Copilot'],['zai','Z.AI'],['openrouter','OpenRouter'],
  ['deepseek','DeepSeek'],['deepinfra','DeepInfra'],['kimi','Kimi'],['kilo','Kilo'],['novita','Novita'],['synthetic','Synthetic'],['moonshot','Moonshot'],
  ['grok','Grok'],['supergrok','SuperGrok'],['grokbot','Grok Bot'],['antigravity','Antigravity'],['cursor','Cursor'],['minimax','MiniMax'],['kiro','Kiro'],
  ['nous','Nous Research'],['opencode-go','OpenCode Go'],['commandcode','Command Code'],['ollama','Ollama Cloud'],['orcarouter','OrcaRouter'],
  ['modelstudio','Model Studio'],['lyceum','Lyceum'],['devin','Devin'],['cline','Cline'],['muse-code','Muse Code'],['droid','Droid'],
] as const;

/** Agent name (Herdr's detector label or the companion's hook-report name, matched as a lowercase word) → the account whose quota that agent spends.
 * Agents with no supported collector (Gemini CLI, Amp, pi, omp, Qwen Code, Letta, Aider, ...) are absent: they show "no usage", never another agent's quota. */
export const agentProviders: readonly (readonly [RegExp,string])[] = [
  [/\bclaude\b/,'anthropic'],[/\bcodex\b/,'openai'],[/\bcopilot\b/,'copilot'],[/\bcursor\b/,'cursor'],[/\bdroid\b/,'droid'],[/\bkimi\b/,'kimi'],
  [/\bcline\b/,'cline'],[/\bkiro\b/,'kiro'],[/\bdevin\b/,'devin'],[/\b(?:antigravity|agy)\b/,'antigravity'],[/\bgrok\b/,'supergrok'],
  [/\bhermes\b/,'nous'],[/\bkilo\b/,'kilo'],[/\bmuse\b/,'muse-code'],[/\bopen-?code\b/,'opencode-go'],[/\bcommand ?code\b/,'commandcode'],
];
export const providerName=(id:string)=>usageProviders.find(([slug])=>slug===id)?.[1]??id;

export type UsageBarMode = 'follow'|'fixed'|'hidden';
/** What the usage item shows: `providerId` null is an agent with no supported account; `label` names that agent or the provider. `agent` is true when it follows the pane; `pending` while the pane has not been read yet. */
export type UsageTarget = {providerId:string|null;label:string;agent:boolean;pending?:boolean};

/** The strict target of the usage item, or null for the host's default account (the report's primary).
 * `agent` is the name of the agent in the current pane: null when none is detected, undefined while the first read is pending. */
export function usageTarget(mode:UsageBarMode,provider:string,agent:string|null|undefined):UsageTarget|null {
  if(mode==='follow' && agent===undefined)return {providerId:null,label:'',agent:true,pending:true};
  if(mode==='follow' && agent) {
    const id=agentProviders.find(([match])=>match.test(agent.toLowerCase()))?.[1]??null;
    return {providerId:id,label:id?providerName(id):agent,agent:true};
  }
  return provider?{providerId:provider,label:providerName(provider),agent:false}:null;
}

/** The report entry for a target: the provider's own account, else its first named account. */
export const entryForTarget=(entries:readonly AccountUsageEntry[],{providerId}:UsageTarget):AccountUsageEntry|undefined=>providerId===null?undefined
  :entries.find(entry=>entry.id===providerId)??entries.find(entry=>entry.id.startsWith(`${providerId}@`));
