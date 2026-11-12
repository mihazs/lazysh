import {useEffect, useState, type FormEvent} from 'react';
import {Check, MessageSquareText, X} from 'lucide-react';
import {t} from './i18n/core';

/** The permission updates Claude Code suggested for one request, as the host companion lists them. A shape this
 * client cannot read is dropped, so nothing it does not understand is ever offered. */
type Destination = 'session' | 'localSettings' | 'projectSettings' | 'userSettings';
export type Suggestion = Readonly<
  | {type: 'addRules'; rules: readonly Readonly<{toolName: string; ruleContent?: string}>[]; destination: Destination}
  | {type: 'setMode'; mode: string; destination: Destination}
  | {type: 'addDirectories'; directories: readonly string[]; destination: Destination}
>;
/** One answer: allow (optionally with the suggestion at `option`) or deny (optionally with a message the agent reads). */
export type Answer = Readonly<{decision: 'allow' | 'deny'; option?: number; message?: string}>;

const destinations: readonly string[] = ['session', 'localSettings', 'projectSettings', 'userSettings'];
const modes: readonly string[] = ['default', 'auto', 'acceptEdits', 'dontAsk', 'plan'];
const maxOptions = 8;
const maxMessage = 500;
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/\p{Cc}/u.test(value);

function parseSuggestion(value: unknown): Suggestion | undefined {
  if (!value || typeof value !== 'object') return;
  const entry = value as Record<string, unknown>;
  if (typeof entry.destination !== 'string' || !destinations.includes(entry.destination)) return;
  const destination = entry.destination as Destination;
  if (entry.type === 'setMode') return typeof entry.mode === 'string' && modes.includes(entry.mode) ? {type: 'setMode', mode: entry.mode, destination} : undefined;
  if (entry.type === 'addDirectories') {
    const paths = entry.directories;
    return Array.isArray(paths) && paths.length >= 1 && paths.length <= maxOptions && paths.every(path => plain(path, 4096)) ? {type: 'addDirectories', directories: paths, destination} : undefined;
  }
  if (entry.type !== 'addRules' || entry.behavior !== 'allow' || !Array.isArray(entry.rules) || entry.rules.length < 1 || entry.rules.length > maxOptions) return;
  const rules = entry.rules.map((rule: unknown) => {
    const item = rule as Record<string, unknown> | null;
    return item && plain(item.toolName, 256) && (item.ruleContent === undefined || plain(item.ruleContent, 2048)) ? {toolName: item.toolName, ...(item.ruleContent === undefined ? {} : {ruleContent: item.ruleContent as string})} : undefined;
  });
  return rules.every(Boolean) ? {type: 'addRules', rules: rules as {toolName: string; ruleContent?: string}[], destination} : undefined;
}
export function parseOptions(value: unknown): readonly Suggestion[] {
  return Array.isArray(value) ? value.slice(0, maxOptions).map(parseSuggestion).filter((item): item is Suggestion => item !== undefined) : [];
}

const where = {session: 'approvalsWhereSession', localSettings: 'approvalsWhereLocal', projectSettings: 'approvalsWhereProject', userSettings: 'approvalsWhereUser'} as const;
const ruleText = (rule: {toolName: string; ruleContent?: string}) => rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`;
function label(option: Suggestion) {
  if (option.type === 'setMode') return t('approvalsOptionMode', {mode: option.mode});
  if (option.type === 'addDirectories') return t('approvalsOptionDirectories');
  return t(option.destination === 'session' ? 'approvalsOptionRuleSession' : 'approvalsOptionRule', {rule: option.rules.map(ruleText).join(', ')});
}
/** What choosing the option will do, with the exact text Claude Code receives. */
function detail(option: Suggestion) {
  const place = t(where[option.destination]);
  if (option.type === 'setMode') return {intro: t('approvalsConfirmMode', {where: place}), lines: [option.mode]};
  if (option.type === 'addDirectories') return {intro: t('approvalsConfirmDirectories', {where: place}), lines: option.directories};
  return {intro: t('approvalsConfirmRules', {where: place}), lines: option.rules.map(ruleText)};
}

/** Deny and Allow, then the request's other answers: allow with a suggested permission update (each behind its own
 * confirmation that shows the exact rule, and none is ever the default) and deny with a message for the agent.
 * A delay keeps a tap that landed as the card appeared from deciding. */
export function ApprovalActions({options, disabled, delay, decide}: {options: readonly Suggestion[]; disabled: boolean; delay: number; decide: (answer: Answer) => void}) {
  const [ready, setReady] = useState(delay === 0);
  const [step, setStep] = useState<{option: number} | {message: string} | null>(null);
  useEffect(() => { if (!delay) return; const timer = window.setTimeout(() => setReady(true), delay); return () => window.clearTimeout(timer); }, [delay]);
  const blocked = disabled || !ready;
  const option = step && 'option' in step ? options[step.option] : undefined;
  const message = step && 'message' in step ? step.message.trim() : '';
  function sendMessage(event: FormEvent) { event.preventDefault(); if (message && !blocked) decide({decision: 'deny', message}); }
  return <>
    <div className="approval-actions">
      <button type="button" className="approval-deny" disabled={blocked} onClick={() => decide({decision: 'deny'})}><X size={16} aria-hidden="true" />{t('approvalsDeny')}</button>
      <button type="button" className="approval-allow" disabled={blocked} onClick={() => decide({decision: 'allow'})}><Check size={16} aria-hidden="true" />{t('approvalsAllow')}</button>
    </div>
    {!step && <div className="approval-more">
      {options.map((item, index) => <button key={index} type="button" className="approval-option" disabled={blocked} onClick={() => setStep({option: index})}>{label(item)}</button>)}
      <button type="button" className="approval-option" disabled={blocked} onClick={() => setStep({message: ''})}><MessageSquareText size={16} aria-hidden="true" />{t('approvalsDenyMessage')}</button>
    </div>}
    {option && step && 'option' in step && <section className="approval-confirm" aria-label={label(option)}>
      <p>{detail(option).intro}</p>
      <ul>{detail(option).lines.map(line => <li key={line}><code>{line}</code></li>)}</ul>
      <div className="approval-actions">
        <button type="button" className="approval-deny" onClick={() => setStep(null)}>{t('approvalsConfirmCancel')}</button>
        <button type="button" className="approval-allow" disabled={blocked} onClick={() => decide({decision: 'allow', option: step.option})}>{t('approvalsConfirmApply')}</button>
      </div>
    </section>}
    {step && 'message' in step && <form className="approval-confirm" onSubmit={sendMessage}>
      <label>{t('approvalsMessageLabel')}
        <input type="text" value={step.message} maxLength={maxMessage} autoFocus autoComplete="off" onChange={event => setStep({message: event.target.value})} />
      </label>
      <div className="approval-actions">
        <button type="button" className="approval-deny" onClick={() => setStep(null)}>{t('approvalsConfirmCancel')}</button>
        <button type="submit" className="approval-deny" disabled={blocked || !message}>{t('approvalsMessageSend')}</button>
      </div>
    </form>}
  </>;
}
