import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {Check, MessageSquareText, ShieldAlert, Square, X} from 'lucide-react';
import {t, useUi} from './i18n/core';
import {captureUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import {parseSnapshot, type AgentSession} from './AgentPanel';
import {parseTerminalSnapshot} from './ChatTerminalInput';
import type {AccessLease, bindProtectedInvoke} from './access';
import './ApprovalPanel.css';

type Option = {value: string; label: string; description?: string | null};
type Field = {key: string; type: 'string' | 'multiselect' | 'boolean' | 'number' | 'integer'; title?: string; description?: string; required?: boolean; custom?: boolean; options?: Option[]};
type Identity = {id: string; expectedHash: string; expiresAt: string; supported: boolean};
type Permission = Identity & {kind: 'permission'; action: string; resources: string[]; save: string[]; message?: string};
type Form = Identity & {kind: 'form'; title: string | null; fields: Field[]};
type Request = Permission | Form;
type Listing = {running: boolean; requests: Request[]};

const reasons = {gone: 'openCodeGone', changed: 'openCodeChanged', expired: 'openCodeExpired', pane: 'openCodePane', invalid: 'openCodeInvalid', unsupported: 'openCodeUnsupported', unavailable: 'openCodeUnavailable', idle: 'openCodeIdle', refused: 'openCodeRefused'} as const;
type Reason = keyof typeof reasons;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string' && item.length <= 8192);

function parseField(value: unknown): Field {
  const field = value as Field;
  const options = field?.options;
  if (!field || typeof field.key !== 'string' || !['string', 'multiselect', 'boolean', 'number', 'integer'].includes(field.type)
    || (options !== undefined && (!Array.isArray(options) || options.length > 50 || options.some(option => typeof option?.value !== 'string' || typeof option.label !== 'string')))) throw new Error('field');
  return field;
}
/** The listing as the host companion prints it. Anything this client cannot read hides the dock: the prompt stays in the terminal. */
export function parseListing(value: unknown): Listing | undefined {
  const listing = value as {schemaVersion?: number; service?: {available?: boolean}; running?: boolean; requests?: Request[]} | null;
  if (listing?.schemaVersion !== 1 || listing.service?.available !== true || !Array.isArray(listing.requests) || listing.requests.length > 20) return undefined;
  try {
    const requests = listing.requests.map((item): Request => {
      if (!/^(per|frm)_[A-Za-z0-9_]{1,124}$/.test(item.id) || !/^[\da-f]{64}$/i.test(item.expectedHash) || !Number.isFinite(Date.parse(item.expiresAt)) || typeof item.supported !== 'boolean') throw new Error('identity');
      if (item.kind === 'permission' && item.id.startsWith('per_') && typeof item.action === 'string' && strings(item.resources) && strings(item.save)) return item;
      if (item.kind === 'form' && item.id.startsWith('frm_') && Array.isArray(item.fields) && item.fields.length <= 20) return {...item, fields: item.fields.map(parseField)};
      throw new Error('kind');
    });
    return {running: listing.running === true, requests};
  } catch { return undefined; }
}

type Choice = {decision: 'once' | 'always' | 'reject'; message?: string};
/** Allow once, Always allow and Reject. Always allow keeps rules, so it first shows exactly which ones; none is a default. */
function PermissionActions({request, disabled, decide}: {request: Permission; disabled: boolean; decide: (choice: Choice) => void}) {
  const [step, setStep] = useState<'always' | {message: string} | null>(null);
  const message = typeof step === 'object' && step ? step.message.trim() : '';
  const send = (event: FormEvent) => { event.preventDefault(); if (message && !disabled) decide({decision: 'reject', message}); };
  return <>
    <div className="approval-actions">
      <button type="button" className="approval-deny" disabled={disabled} onClick={() => decide({decision: 'reject'})}><X size={16} aria-hidden="true" />{t('openCodeReject')}</button>
      <button type="button" className="approval-allow" disabled={disabled} onClick={() => decide({decision: 'once'})}><Check size={16} aria-hidden="true" />{t('openCodeAllowOnce')}</button>
    </div>
    {!step && <div className="approval-more">
      {request.save.length > 0 && <button type="button" className="approval-option" disabled={disabled} onClick={() => setStep('always')}>{t('openCodeAllowAlways')}</button>}
      <button type="button" className="approval-option" disabled={disabled} onClick={() => setStep({message: ''})}><MessageSquareText size={16} aria-hidden="true" />{t('openCodeRejectMessage')}</button>
    </div>}
    {step === 'always' && <section className="approval-confirm" aria-label={t('openCodeAllowAlways')}>
      <p>{t('openCodeAlwaysConfirm')}</p>
      <ul>{request.save.map(rule => <li key={rule}><code>{rule}</code></li>)}</ul>
      <div className="approval-actions">
        <button type="button" className="approval-deny" onClick={() => setStep(null)}>{t('approvalsConfirmCancel')}</button>
        <button type="button" className="approval-allow" disabled={disabled} onClick={() => decide({decision: 'always'})}>{t('openCodeAllowAlways')}</button>
      </div>
    </section>}
    {typeof step === 'object' && step && <form className="approval-confirm" onSubmit={send}>
      <label>{t('approvalsMessageLabel')}
        <input type="text" value={step.message} maxLength={500} autoFocus autoComplete="off" onChange={event => setStep({message: event.target.value})} />
      </label>
      <div className="approval-actions">
        <button type="button" className="approval-deny" onClick={() => setStep(null)}>{t('approvalsConfirmCancel')}</button>
        <button type="submit" className="approval-deny" disabled={disabled || !message}>{t('openCodeRejectSend')}</button>
      </div>
    </form>}
  </>;
}

type Value = string | number | boolean | string[];
const filled = (value: Value | undefined) => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
/** One control per field the host listed as answerable; the service checks the choices themselves. */
function FormFields({fields, values, set}: {fields: Field[]; values: Record<string, Value>; set: (key: string, value: Value | undefined) => void}) {
  return <>{fields.map(field => {
    const current = values[field.key];
    const label = field.title ?? field.key;
    const options = field.options ?? [];
    const named = <legend>{label}{field.required && ' *'}</legend>;
    const note = field.description && <p className="approval-hint">{field.description}</p>;
    if (field.type === 'multiselect' || (field.type === 'string' && options.length > 0)) {
      const many = field.type === 'multiselect';
      const chosen = (many ? current ?? [] : current === undefined ? [] : [current]) as string[];
      const pick = (value: string, on: boolean) => set(field.key, many ? (on ? [...chosen, value] : chosen.filter(item => item !== value)) : on ? value : undefined);
      return <fieldset key={field.key} className="opencode-field">{named}{note}
        {options.map(option => <label key={option.value}><input type={many ? 'checkbox' : 'radio'} name={field.key} checked={chosen.includes(option.value)} onChange={event => pick(option.value, event.target.checked)} />{option.label}{option.description && <small> {option.description}</small>}</label>)}
        {field.custom && !many && <label>{t('openCodeOther')}<input type="text" maxLength={4096} value={chosen.length === 1 && !options.some(option => option.value === chosen[0]) ? chosen[0] : ''} onChange={event => set(field.key, event.target.value || undefined)} /></label>}
      </fieldset>;
    }
    if (field.type === 'boolean') return <fieldset key={field.key} className="opencode-field">{named}{note}
      {[true, false].map(on => <label key={String(on)}><input type="radio" name={field.key} checked={current === on} onChange={() => set(field.key, on)} />{t(on ? 'openCodeYes' : 'openCodeNo')}</label>)}</fieldset>;
    const numeric = field.type !== 'string';
    return <label key={field.key} className="opencode-field">{label}{field.required && ' *'}{note}
      <input type={numeric ? 'number' : 'text'} step={field.type === 'integer' ? 1 : numeric ? 'any' : undefined} maxLength={numeric ? undefined : 4096} value={current === undefined ? '' : String(current)}
        onChange={event => set(field.key, event.target.value === '' ? undefined : numeric ? Number(event.target.value) : event.target.value)} /></label>;
  })}</>;
}
function FormAnswer({request, disabled, decide}: {request: Form; disabled: boolean; decide: (answer: Record<string, Value>) => void}) {
  const [values, setValues] = useState<Record<string, Value>>({});
  const set = (key: string, value: Value | undefined) => setValues(previous => {
    const next = {...previous};
    if (value === undefined) delete next[key]; else next[key] = value;
    return next;
  });
  const ready = request.fields.every(field => !field.required || filled(values[field.key])) && Object.values(values).every(value => typeof value !== 'number' || Number.isFinite(value));
  return <form className="approval-confirm" onSubmit={event => { event.preventDefault(); if (ready && !disabled) decide(values); }}>
    <FormFields fields={request.fields} values={values} set={set} />
    <div className="approval-actions"><button type="submit" className="approval-allow" disabled={disabled || !ready}>{t('openCodeSend')}</button></div>
  </form>;
}

/** Answers the OpenCode permission requests and question forms of the agent in this terminal's pane, and stops its turn, through the
 * OpenCode background service on the host. Nothing is typed into the terminal, so switching to the terminal shows the prompt closed. */
export default function AgentOpenCodeDock({sessionId, shown, row, access, invoke}: {sessionId: string; shown: boolean; row?: AgentSession; access: AccessLease; invoke: ReturnType<typeof bindProtectedInvoke>}) {
  useUi();
  const match = row?.agent === 'OpenCode' && row.paneId && /^%\d+$/.test(row.paneId) ? {agentSessionId: row.sessionId, paneId: row.paneId} : undefined;
  const [listing, setListing] = useState<Listing>();
  const [reason, setReason] = useState<Reason | ''>('');
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [ready, setReady] = useState('');
  const scope = useRef({match, shown});scope.current = {match, shown};
  const generation = useRef(0);
  const same = (current: typeof match) => !!current && scope.current.shown && scope.current.match?.agentSessionId === current.agentSessionId && scope.current.match.paneId === current.paneId;
  const refresh = useCallback(async () => {
    if (!match || !shown || !access.current() || document.visibilityState === 'hidden') return;
    const current = ++generation.current;
    try {
      const next = parseListing(await invoke('opencode_service_list', {sessionId, agentSessionId: match.agentSessionId}));
      if (current === generation.current && same(match)) setListing(next);
    } catch { if (current === generation.current && same(match)) setListing(undefined); }
  }, [match?.agentSessionId, match?.paneId, shown, access, invoke, sessionId]);
  useEffect(() => { setListing(undefined);setReason('');setError('');setArmed(false); }, [match?.agentSessionId, match?.paneId]);
  // A new hook report (the agent started waiting, or finished) is read at once, between the regular reads.
  useEffect(() => {
    if (!match || !shown) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => {generation.current++;window.clearInterval(timer);};
  }, [refresh, row?.state]);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(false), 4000); return () => window.clearTimeout(timer); }, [armed]);
  const requests = listing?.requests ?? [];
  // What the person is shown, without the hash and expiry the host refreshes with every read: a tap that landed as a card
  // appeared, or as its text changed, must not decide it.
  const content = (request: Request) => JSON.stringify(request.kind === 'permission' ? [request.id, request.supported, request.action, request.resources, request.save, request.message] : [request.id, request.supported, request.title, request.fields]);
  const identity = requests.map(content).join('|');
  useEffect(() => { setReady(''); if (!identity) return; const timer = window.setTimeout(() => setReady(identity), 400); return () => window.clearTimeout(timer); }, [identity]);
  /** The pane this terminal shows still runs this one reported OpenCode session, read again right before anything is sent. */
  async function stillShows() {
    if (!match || !same(match) || !access.current()) return false;
    const pane = parseTerminalSnapshot(await invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}})).destination.paneId;
    if (pane !== match.paneId) return false;
    const rows = parseSnapshot(await invoke('agent_snapshot', {sessionId})).filter(item => item.paneId === pane);
    return rows.length === 1 && rows[0].agent === 'OpenCode' && rows[0].sessionId === match.agentSessionId && access.current() && same(match);
  }
  async function send(command: string, args: Record<string, unknown>) {
    if (busy || !match) return;
    setBusy(true);setReason('');setError('');
    try {
      if (!await stillShows()) { setReason('pane'); return; }
      const result = await invoke<{schemaVersion: number; accepted: boolean; reason?: string}>(command, {sessionId, agentSessionId: match.agentSessionId, paneId: match.paneId, ...args});
      if (result?.schemaVersion !== 1 || typeof result.accepted !== 'boolean') throw new Error('reply');
      if (!result.accepted) setReason(result.reason !== undefined && result.reason in reasons ? result.reason as Reason : 'refused');
    } catch (e) { if (same(match)) setError(captureUiError(e)); }
    finally { setBusy(false);setArmed(false);void refresh(); }
  }
  const reply = (request: Request, extra: Record<string, unknown>) => void send('opencode_service_reply', {id: request.id, expectedHash: request.expectedHash, expiresAt: request.expiresAt, ...extra});
  if (!match || !listing || (!requests.length && !listing.running && !reason && !error)) return null;
  const blocked = busy || ready !== identity;
  return <section className="approval-panel" aria-label={t('openCodeTitle')}>
    {listing.running && <div className="approval-actions">
      <button type="button" className="approval-deny" data-armed={armed || undefined} disabled={busy} onClick={() => armed ? void send('opencode_service_abort', {}) : setArmed(true)}><Square size={16} aria-hidden="true" />{t(armed ? 'agentComposerStopConfirm' : 'chatTerminalStop')}</button>
    </div>}
    {reason && <p role="status" className="approval-note">{t(reasons[reason])}</p>}
    {error && <p role="alert" className="inline-error">{uiErrorText(error)}</p>}
    {requests.map(request => <article className="approval-card" key={request.id} aria-labelledby={`opencode-${request.id}`}>
      <header className="approval-identity">
        <span className="approval-mark" aria-hidden="true"><ShieldAlert size={18} /></span>
        <div className="approval-heading"><h4 id={`opencode-${request.id}`}>OpenCode · {request.kind === 'permission' ? request.action : request.title ?? t('openCodeQuestion')}</h4></div>
        <span className="approval-kind">{t(request.kind === 'permission' ? 'approvalsPermission' : 'openCodeQuestion')}</span>
      </header>
      {request.kind === 'permission' && <pre className="approval-input">{request.resources.join('\n')}</pre>}
      {request.kind === 'permission' && request.message && <p className="approval-hint">{request.message}</p>}
      {!request.supported ? <p className="approval-hint">{t('openCodeNeedsTerminal')}</p>
        : request.kind === 'permission' ? <PermissionActions key={content(request)} request={request} disabled={blocked} decide={choice => reply(request, {decision: choice.decision, ...(choice.message === undefined ? {} : {message: choice.message})})} />
        : <FormAnswer key={content(request)} request={request} disabled={blocked} decide={answer => reply(request, {answer: JSON.stringify(answer)})} />}
    </article>)}
  </section>;
}
