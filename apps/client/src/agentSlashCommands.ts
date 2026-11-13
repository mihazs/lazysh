import type {BoundConversation} from './ChatPanel';

/** A command of an agent's own prompt box. `picker` ones open a dialog in the terminal UI, which the Agent view answers when `liftDialog` can read it and leaves to the terminal otherwise. */
export type SlashCommand = Readonly<{name: string; picker?: true}>;
type Agent = BoundConversation['agent'];

/** From each agent's public command reference; the agent's own `/help` stays the authority, so this lists the common
 * ones rather than every command, and a command a version does not know is answered by the agent itself. */
export const slashCommands: Record<Agent, readonly SlashCommand[]> = {
  claude: [
    {name: 'clear'}, {name: 'compact'}, {name: 'context'}, {name: 'cost'}, {name: 'doctor'}, {name: 'help'}, {name: 'init'},
    {name: 'memory', picker: true}, {name: 'model', picker: true}, {name: 'permissions', picker: true}, {name: 'review'},
    {name: 'resume', picker: true}, {name: 'rewind', picker: true}, {name: 'status', picker: true}, {name: 'agents', picker: true},
    {name: 'mcp', picker: true}, {name: 'config', picker: true}, {name: 'usage'},
  ],
  codex: [
    {name: 'compact'}, {name: 'diff'}, {name: 'init'}, {name: 'new'}, {name: 'review'}, {name: 'status'},
    {name: 'model', picker: true}, {name: 'approvals', picker: true}, {name: 'resume', picker: true}, {name: 'mcp'}, {name: 'mention', picker: true},
  ],
  gemini: [
    {name: 'about'}, {name: 'clear'}, {name: 'compress'}, {name: 'copy'}, {name: 'help'}, {name: 'init'}, {name: 'mcp'}, {name: 'plan'},
    {name: 'stats'}, {name: 'tools'}, {name: 'auth', picker: true}, {name: 'memory', picker: true}, {name: 'model', picker: true},
    {name: 'permissions', picker: true}, {name: 'resume', picker: true}, {name: 'rewind', picker: true}, {name: 'settings', picker: true},
    {name: 'theme', picker: true},
  ],
};

/** The commands a draft is asking for: only while the first word is being typed, never inside a longer prompt. */
export function matchSlash(agent: Agent, draft: string): readonly SlashCommand[] | undefined {
  const typed = /^\/([a-z-]*)$/i.exec(draft);
  if (!typed) return;
  const query = typed[1].toLowerCase();
  const items = slashCommands[agent].filter(command => command.name.startsWith(query));
  return items.length ? items : undefined;
}

export const slashText = (command: SlashCommand) => `/${command.name} `;

/** The first character that switches the prompt box into another mode in the agent's own UI. */
export type PromptMode = 'bash' | 'memory';
export function promptMode(agent: Agent, draft: string): PromptMode | undefined {
  if (draft.startsWith('!')) return 'bash';
  if (agent === 'claude' && draft.startsWith('#')) return 'memory';
}

/** The command a draft starts with when that command opens a dialog in the terminal UI. */
export function pickerCommand(agent: Agent, draft: string): SlashCommand | undefined {
  const typed = /^\/([a-z-]+)(?:\s|$)/i.exec(draft);
  return typed ? slashCommands[agent].find(command => command.picker && command.name === typed[1].toLowerCase()) : undefined;
}
