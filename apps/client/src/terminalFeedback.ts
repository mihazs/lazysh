import type {BackendSelection} from './terminalBackendRegistry';
import {appVersion} from './version';

/** What a terminal problem report carries: the engine and why, never anything of the session. */
export type TerminalReport = {
  /** The engine of the session in question: `native` or `xterm`. */
  engine?: string;
  /** The Settings choice: `auto`, `native` or `xterm`. */
  preference?: string;
  /** The reasons the registry recorded, as it recorded them. */
  reasons?: readonly string[];
};

const ISSUES = 'https://github.com/mihazs/lazysh/issues';
/** `open_web_url` takes at most 4096 characters of the link; a reason is cut until the encoded link fits with some room. */
const MAX_URL = 4000;
const MAX_REASON = 300;

/** The report of a session: its engine and every reason its selection recorded. */
export const reportOfSession = ({id, reason, fallbacks}: BackendSelection, preference?: string): TerminalReport =>
  ({engine: id, preference: preference ?? 'auto', reasons: [reason, ...fallbacks.map(fallback => `${fallback.id}: ${fallback.reason}`)]});

/**
 * The issue form of the repository with the engine, the setting, the recorded reasons and the app version filled in, as the user's
 * browser opens it: lazysh sends nothing. The headings are those of the bug template, so the rest is for the reporter to write.
 */
export function terminalFeedbackUrl({engine, preference, reasons = []}: TerminalReport): string {
  const form = (reasonLength: number) => {
    const body = [
      '**Version**', `lazysh ${appVersion}`, '',
      '**Terminal engine**', ...(engine ? [`- Engine: ${engine}`] : []), ...(preference ? [`- Setting: ${preference}`] : []),
      ...reasons.slice(0, 4).map(reason => `- Reason: ${reason.slice(0, reasonLength)}`), '',
      '**What happened**', '', '**What I expected**', '', '**Steps to reproduce**', '1.', '',
    ].join('\n');
    return `${ISSUES}/new?${new URLSearchParams({labels: 'bug', title: 'Terminal engine: ', body})}`;
  };
  let length = MAX_REASON, url = form(length);
  while (url.length > MAX_URL && length > 0) url = form(length = Math.floor(length / 2));
  return url;
}
