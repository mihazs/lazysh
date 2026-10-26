export const usageAgents: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  omp: "OMP",
  hermes: "Hermes",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  "qoder-ide": "Qoder IDE",
  kimi: "Kimi CLI",
  jcode: "jcode",
  droid: "Factory Droid",
  cursor: "Cursor IDE",
  omo: "OmO Native",
  "devin-atif": "Devin ATIF export",
  "amp-json": "Amp JSON export",
};
export const transcriptAgents: Record<string, string> = {
  ...usageAgents,
  "grok-acp": "Grok ACP records",
  "antigravity-jsonl": "Antigravity step records (explicit file)",
};
export type DiscoveredTranscript = { path: string; name: string; sessionId?: string };
export function isDiscoveredTranscript(value: unknown, sessionIdLimit: number): value is DiscoveredTranscript {
  if (!value) return false;
  const item = value as DiscoveredTranscript;
  return typeof item.path === "string" && item.path.length <= 4096
    && typeof item.name === "string" && item.name.length <= 4096
    && (item.sessionId === undefined || (typeof item.sessionId === "string" && item.sessionId.length <= sessionIdLimit));
}
