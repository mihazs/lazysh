import {t} from './i18n/core';
import type {Host} from './bridge';
import type {PaletteCommand} from './paletteModel';
import {navigationHint, type ChordHint} from './keyboard';
import type {NavigationBindings} from './navigationBindings';

type Action = () => void;
type ActionRow = readonly [id: string, label: string, run: Action, disabled?: boolean, aliases?: readonly string[], shortcut?: ChordHint];
/** Everything the palette may offer, as currently allowed by the workspace. */
export type PaletteContext = Readonly<{
  native: boolean;
  hosts: readonly Host[];
  sessions: readonly Readonly<{id: string; name: string; destination: string; connected: boolean}>[];
  activeId: string | null;
  tools: readonly Readonly<{id: string; label: string}>[];
  currentTool?: string;
  /** Tools and workspaces wait while a multiplexer launch owns the session. */
  navigationBusy: boolean;
  navigationShortcuts: NavigationBindings;
  local: Readonly<{available: boolean; busy: boolean; reason: string}>;
  run: Readonly<{
    host: (host: Host) => void; local: Action; addHost: Action; session: (id: string) => void;
    tool: (id: string) => void; workspaces: Action; switcher: Action; closeActive: Action;
    preferences: Action; push: Action; inbox: Action; sync: Action; sharing: Action; about: Action;
  }>;
}>;

/** Untranslated aliases help people who learned another locale's or the CLI's names. */
const toolAliases: Readonly<Record<string, readonly string[]>> = {
  terminal: ['shell', 'console'], files: ['browse', 'sftp', 'image', 'markdown'], diff: ['git', 'review', 'changes'],
  sessions: ['tmux', 'zellij', 'herdr', 'multiplexer', 'workspace'], chat: ['chat', 'conversation'],
  preview: ['browser', 'port', 'forward'], agents: ['codex', 'claude'], usage: ['quota', 'account'],
};

/** Builds the ordered command list: local terminal and hosts, sessions, tools, then application actions. */
export function paletteCommands(context: PaletteContext): PaletteCommand[] {
  const {run} = context;
  const host = t('paletteGroupHost'), session = t('paletteGroupSession'), tool = t('paletteGroupTool'), action = t('paletteGroupAction');
  const active = context.sessions.find(item => item.id === context.activeId);
  const commands: PaletteCommand[] = [
    {id: 'local', group: 'host', label: t('appLocalTerminalThisDevice'), keywords: [host, 'local'], disabled: !context.local.available || context.local.busy, reason: context.local.reason, run: run.local},
    ...context.hosts.map((item): PaletteCommand => ({id: `host:${item.id}`, group: 'host', label: item.name, detail: `${item.username}@${item.hostname}`, keywords: [host], run: () => run.host(item)})),
    ...context.sessions.map((item): PaletteCommand => ({id: `session:${item.id}`, group: 'session', label: item.name, detail: item.destination, keywords: [session], current: item.id === context.activeId, disabled: !item.connected, run: () => run.session(item.id)})),
    ...context.tools.map((item): PaletteCommand => ({id: `tool:${item.id}`, group: 'tool', label: item.label, detail: active?.name, keywords: [tool, ...(toolAliases[item.id] ?? [])], current: item.id === context.currentTool, disabled: item.id === 'agents' && context.navigationBusy, shortcut: item.id === 'agents' ? navigationHint(context.navigationShortcuts.agents) : undefined, run: () => run.tool(item.id)})),
  ];
  const actions: ActionRow[] = [
    ['add-host', t('appAddANewHost'), run.addHost, !context.native, ['ssh', 'new']],
    ...(active ? [
      ['workspaces', t('navigationWorkspaces'), run.workspaces, context.navigationBusy, ['tmux', 'zellij', 'herdr'], navigationHint(context.navigationShortcuts.workspaces)],
      ['switcher', t('appSwitchTerminalSession'), run.switcher, false, ['tab']],
    ] satisfies ActionRow[] : []),
    ['preferences', t('appPreferences'), run.preferences, false, ['settings']],
    ['push', t('appRemotePushSettings'), run.push, false, ['settings', 'notifications']],
    ['inbox', t('appOpenNotificationInbox'), run.inbox, !context.native, ['notifications']],
    ['sync', t('appOpenEncryptedSync'), run.sync, !context.native, ['settings', 'webdav']],
    ['sharing', t('appOpenShareableUploads'), run.sharing, !context.native, ['share', 'upload']],
    ['about', t('appAboutLazysh'), run.about, false, ['license', 'version']],
    ...(active ? [['close', t('appEndValue1Connection', {value1: active.name}), run.closeActive, false, ['close', 'disconnect']]] satisfies ActionRow[] : []),
  ];
  for (const [id, label, handler, disabled, aliases, shortcut] of actions)
    commands.push({id: `action:${id}`, group: 'action', label, keywords: [action, ...(aliases ?? [])], disabled, shortcut, run: handler});
  return commands;
}
