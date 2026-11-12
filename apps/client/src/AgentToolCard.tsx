import {useState} from 'react';
import {Ban, Check, Copy, FileDiff, Globe, LoaderCircle, Pencil, Search, Terminal, Wrench, X, FileText} from 'lucide-react';
import {describeTool, tail, type ToolKind, type ToolResult, type ToolStatus, type ToolUse} from './agentToolCall';
import {fileChanges} from './agentDiff';
import {t} from './i18n/core';
import './AgentToolCard.css';

const icons = {execute: Terminal, read: FileText, search: Search, fetch: Globe, edit: Pencil, other: Wrench} as const satisfies Record<ToolKind, unknown>;
const marks = {running: LoaderCircle, ok: Check, error: X, denied: Ban} as const satisfies Record<ToolStatus, unknown>;
const statusText = {running: 'agentToolRunning', ok: 'agentToolOk', error: 'agentToolError', denied: 'agentToolDenied'} as const satisfies Record<ToolStatus, string>;
const TAIL = 20, DIFF_HEAD = 40;

function CopyButton({text, label}: {text: string; label: 'agentToolCopy' | 'agentDiffCopy'}) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="subtle-button agent-tool-copy" onClick={async () => {
    try {await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500);} catch {/* the clipboard can be refused; the text stays on screen */}
  }}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}<span>{copied ? t('agentToolCopied') : t(label)}</span></button>;
}

/** One card for a recorded tool call and its result: a one-line summary, the outcome, and the output tail with Show all and Copy.
 * An edit shows the lines it changed instead. `live` says the agent is still working, so a call without a result is running. */
export default function AgentToolCard({use, result, live}: {use: ToolUse; result?: ToolResult; live: boolean}) {
  const call = describeTool(use, result);
  const files = fileChanges(call);
  const [all, setAll] = useState(false), [wrap, setWrap] = useState(true);
  const Icon = files.length ? FileDiff : icons[call.kind], Mark = marks[call.status];
  const shown = call.status !== 'running' || live;
  const added = files.reduce((sum, file) => sum + file.added, 0), removed = files.reduce((sum, file) => sum + file.removed, 0);
  const out = call.output === undefined ? undefined : all ? {lines: call.output, hidden: 0} : tail(call.output, TAIL);
  const diffText = files.map(file => `${file.path}\n${file.lines.map(line => `${line.kind}${line.text}`).join('\n')}`).join('\n\n');
  const long = files.some(file => file.lines.length > DIFF_HEAD);
  return <details className="agent-tool" data-kind={files.length ? 'diff' : call.kind} data-status={shown ? call.status : 'unknown'}>
    <summary>
      <Icon size={16} aria-hidden="true" />
      <strong>{call.name || t('chatBlockToolUse')}</strong>
      <span className="agent-tool-summary">{call.summary}</span>
      {files.length > 0 && <span className="agent-diff-counts" aria-label={t('agentDiffCounts', {added, removed})}><span data-kind="+">+{added}</span> <span data-kind="-">−{removed}</span></span>}
      {shown && <span className="agent-tool-status"><Mark size={14} aria-hidden="true" />{t(statusText[call.status])}{call.exitCode !== undefined && ` · ${t('agentToolExit', {code: call.exitCode})}`}</span>}
    </summary>
    {files.length > 0 ? <>
      {files.map((file, index) => <section key={index} className="agent-diff-file">
        {files.length > 1 && <h5>{file.path} <span className="agent-diff-counts">+{file.added} −{file.removed}</span></h5>}
        <pre className="agent-diff-lines" data-wrap={wrap}>{(all ? file.lines : file.lines.slice(0, DIFF_HEAD)).map((line, row) => <span key={row} data-kind={line.kind}>{line.kind}{line.text}{'\n'}</span>)}</pre>
      </section>)}
      <div className="agent-tool-actions">
        {long && <button type="button" className="subtle-button" onClick={() => setAll(value => !value)}>{all ? t('agentToolFewer') : t('agentToolShowAll')}</button>}
        <button type="button" className="subtle-button" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>{t('agentDiffWrap')}</button>
        <CopyButton text={diffText} label="agentDiffCopy" />
      </div>
    </> : <>
      {call.kind === 'execute' && call.summary && <pre className="agent-tool-input">{String(call.input.command ?? call.input.cmd ?? '')}</pre>}
      {call.kind !== 'execute' && Object.keys(call.input).length > 0 && <pre className="agent-tool-input">{JSON.stringify(call.input, null, 2)}</pre>}
      {out && out.lines && <pre className="agent-tool-output" aria-label={t('agentToolOutput')}>{out.lines}</pre>}
      <div className="agent-tool-actions">
        {out && out.hidden > 0 && <button type="button" className="subtle-button" onClick={() => setAll(true)}>{t('agentToolEarlier', {count: out.hidden})}</button>}
        {all && call.output && call.output.split('\n').length > TAIL && <button type="button" className="subtle-button" onClick={() => setAll(false)}>{t('agentToolFewer')}</button>}
        {call.output && <CopyButton text={call.output} label="agentToolCopy" />}
      </div>
    </>}
  </details>;
}
