/** The `session` object of a conversation page: model, mode, context, cost and where the agent works as the companion read them.
 * Absent means unknown; a malformed field is dropped on its own and never raises an error. */
export type RateLimit = {kind: 'primary' | 'secondary'; usedPercent: number; windowMinutes?: number; resetsAt?: number};
/** What the session has loaded, from its attachment records: MCP servers and whether they connected, skills, agent types, instruction files. */
export type McpState = 'connected' | 'pending' | 'failed';
export type AgentRoster = {
  mcp?: {name: string; state: McpState; toolCount?: number}[]; skills?: string[]; agents?: string[]; instructionFiles?: {name: string; kind?: string}[];
};
export type AgentSessionInfo = {
  info?: AgentRoster;
  model?: string; mode?: string; effort?: string; approval?: string; sandbox?: string;
  /** Last component of the working directory, the git branch and the worktree name: names, never paths. */
  folder?: string; branch?: string; worktree?: string;
  usage?: {usedTokens: number; limitTokens?: number}; cost?: {usd: number}; rateLimits?: RateLimit[];
};

const label = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined;
/** A folder or branch name is any printable text, unlike the identifier labels above. */
const name = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\p{Cc}]/u.test(value) ? value : undefined;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const list = (value: unknown, max: number): unknown[] => Array.isArray(value) ? value.slice(0, max) : [];
const names = (value: unknown, max: number) => list(value, max).flatMap(item => { const text = name(item); return text ? [text] : []; });

export function parseRoster(value: unknown): AgentRoster | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const roster: AgentRoster = {};
  const mcp = list(raw.mcp, 50).flatMap((item): NonNullable<AgentRoster['mcp']> => {
    const server = record(item), text = name(server?.name), tools = count(server?.toolCount);
    return server && text && ['connected', 'pending', 'failed'].includes(server.state as string)
      ? [{name: text, state: server.state as McpState, ...(tools ? {toolCount: tools} : {})}] : [];
  });
  if (mcp.length) roster.mcp = mcp;
  for (const [key, max] of [['skills', 200], ['agents', 100]] as const) {
    const found = names(raw[key], max);
    if (found.length) roster[key] = found;
  }
  const files = list(raw.instructionFiles, 32).flatMap((item): NonNullable<AgentRoster['instructionFiles']> => {
    const file = record(item), text = name(file?.name), kind = label(file?.kind);
    return text ? [{name: text, ...(kind ? {kind} : {})}] : [];
  });
  if (files.length) roster.instructionFiles = files;
  return Object.keys(roster).length ? roster : undefined;
}

export function parseSession(value: unknown): AgentSessionInfo | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const session: AgentSessionInfo = {};
  const info = parseRoster(raw.info);
  if (info) session.info = info;
  for (const key of ['model', 'mode', 'effort', 'approval', 'sandbox'] as const) {
    const text = label(raw[key]);
    if (text) session[key] = text;
  }
  for (const key of ['folder', 'branch', 'worktree'] as const) {
    const text = name(raw[key]);
    if (text) session[key] = text;
  }
  const usage = record(raw.usage), used = count(usage?.usedTokens), limit = count(usage?.limitTokens);
  if (used !== undefined) session.usage = limit ? {usedTokens: used, limitTokens: limit} : {usedTokens: used};
  const usd = record(raw.cost)?.usd;
  if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) session.cost = {usd};
  if (Array.isArray(raw.rateLimits)) {
    const limits = raw.rateLimits.slice(0, 4).flatMap((item): RateLimit[] => {
      const limit = record(item), percent = limit?.usedPercent;
      if (!limit || !['primary', 'secondary'].includes(limit.kind as string) || typeof percent !== 'number' || !(percent >= 0 && percent <= 100)) return [];
      const minutes = count(limit.windowMinutes), resetsAt = count(limit.resetsAt);
      return [{kind: limit.kind as RateLimit['kind'], usedPercent: percent, ...(minutes ? {windowMinutes: minutes} : {}), ...(resetsAt ? {resetsAt} : {})}];
    });
    if (limits.length) session.rateLimits = limits;
  }
  return Object.keys(session).length ? session : undefined;
}

/** Share of the context window still free, 0-100, or undefined while the window is not recorded. */
export function contextLeft(session?: AgentSessionInfo): number | undefined {
  const usage = session?.usage;
  return usage?.limitTokens ? Math.max(0, Math.min(100, Math.round(100 - usage.usedTokens / usage.limitTokens * 100))) : undefined;
}
