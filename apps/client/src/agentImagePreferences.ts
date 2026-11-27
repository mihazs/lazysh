import type {BoundConversation} from './ChatPanel';

export const agentNames: Record<BoundConversation['agent'], string> = {claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', 'grok-acp': 'Grok Build'};
/** Image previews cost bytes on a mobile link: on by default for Claude Code, opt-in for Codex whose companion support is newer. Kept per viewer. */
const imageDefaults: Record<BoundConversation['agent'], boolean> = {claude: true, codex: false, opencode: false, gemini: false, 'grok-acp': false};
export function storedImages() {
  try {return {...imageDefaults, ...JSON.parse(localStorage.getItem('lazysh.agentImages') ?? '{}')} as Record<BoundConversation['agent'], boolean>;} catch {return imageDefaults;}
}
export function saveAgentImages(images: ReturnType<typeof storedImages>) {
  try {localStorage.setItem('lazysh.agentImages',JSON.stringify(images));} catch { /* The choice lasts until reload. */ }
}
