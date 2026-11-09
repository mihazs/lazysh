import {useEffect, useMemo, useRef, useState} from 'react';
import {TerminalSquare} from 'lucide-react';
import ChatPanel, {type BoundConversation} from './ChatPanel';
import {parseReportedHistory, parseSnapshot, reportedStateNames, type AgentSession} from './AgentPanel';
import {parseTerminalSnapshot, type TerminalInputLabels} from './ChatTerminalInput';
import {StatusRing, reportedTones} from './AgentStatus';
import {formatCountdown, useNow} from './relativeTime';
import {bindProtectedInvoke, captureAccess} from './access';
import {t, useUi} from './i18n/core';
import './AgentView.css';

const conversationAgents: Record<string, BoundConversation['agent']> = {'Claude Code': 'claude', Codex: 'codex'};
type Binding = {kind: 'finding'} | {kind: 'none'} | {kind: 'partial'; row: AgentSession} | {kind: 'bound'; row: AgentSession; conversation: BoundConversation};

/** Another view of the same live session: the agent conversation that hook reports tie to this terminal's pane.
 * It never writes to the terminal; input goes through the confirmed input or Stage like Chat. */
export default function AgentView({sessionId, shown, tmux, terminalInput, onShowTerminal}: {
  sessionId: string; shown: boolean; tmux: boolean; terminalInput?: TerminalInputLabels; onShowTerminal: () => void;
}) {
  useUi();
  const [access] = useState(captureAccess);
  const invoke = useMemo(() => bindProtectedInvoke(access), [access]);
  const [binding, setBinding] = useState<Binding>({kind: 'finding'});
  const [manual, setManual] = useState(false);
  // Available reported history per agent session id, so polling only re-reads the board.
  // A missing one is asked again on the next poll: the user may turn it on, or it may be reported later.
  const histories = useRef(new Map<string, BoundConversation>());
  const [turnStart, setTurnStart] = useState<string>();
  useEffect(() => {
    if (!shown) return;
    let alive = true, flight = false;
    async function bind() {
      if (flight || document.visibilityState === 'hidden' || !access.current()) return;
      flight = true;
      try {
        // Pane identity is the evidence: only TMUX_PANE ties a hook report to this terminal.
        const pane = tmux ? parseTerminalSnapshot(await invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}})).destination.paneId : undefined;
        const row = pane === undefined ? undefined : parseSnapshot(await invoke('agent_snapshot', {sessionId})).find(row => row.paneId === pane);
        const agent = row && conversationAgents[row.agent];
        if (row && agent && !histories.current.has(row.sessionId)) {
          const history = parseReportedHistory(await invoke('agent_reported_history', {sessionId, agentSessionId: row.sessionId}), row.sessionId);
          if (history.status === 'available') histories.current.set(row.sessionId, Object.freeze({agent, path: history.path}));
        }
        const conversation = row && histories.current.get(row.sessionId);
        if (alive) setBinding(previous => !row ? {kind: 'none'} : !conversation ? {kind: 'partial', row}
          : {kind: 'bound', row, conversation: previous.kind === 'bound' && previous.conversation.path === conversation.path && previous.conversation.agent === conversation.agent ? previous.conversation : conversation});
      } catch {
        // A failed read keeps what was found; with nothing found yet the fallback offers the terminal.
        if (alive) setBinding(previous => previous.kind === 'finding' ? {kind: 'none'} : previous);
      } finally { flight = false; }
    }
    void bind();
    const timer = setInterval(() => void bind(), 5000);
    return () => {alive = false; clearInterval(timer);};
  }, [shown, sessionId, tmux, invoke, access]);
  const row = binding.kind === 'bound' || binding.kind === 'partial' ? binding.row : undefined;
  const reader = manual || binding.kind === 'bound';
  // Elapsed time of the running turn, from its prompt in the conversation.
  const started = binding.kind === 'bound' && row?.state !== 'done' && turnStart ? Date.parse(turnStart) : NaN;
  const now = useNow(1000, shown && Number.isFinite(started));
  return <section className="agent-view" hidden={!shown} aria-label={t('agentViewTitle')}>
    <header className="agent-view-header">
      {row ? <>
        <StatusRing tone={reportedTones[row.state]} />
        <strong>{row.agent}</strong>
        <span>{t(reportedStateNames[row.state])}</span>
        {Number.isFinite(started) && <time dateTime={turnStart} title={t('agentViewElapsed')}>{formatCountdown(now - started)}</time>}
      </> : <strong>{t('agentViewTitle')}</strong>}
      <button type="button" className="subtle-button" onClick={onShowTerminal}><TerminalSquare size={18} aria-hidden="true" />{t('agentViewTerminal')}</button>
    </header>
    {binding.kind === 'finding' && !manual && <p role="status">{t('agentViewFinding')}</p>}
    {!reader && binding.kind !== 'finding' && <div className="agent-view-fallback">
      <p>{binding.kind === 'partial' ? t('agentViewPartial', {agent: binding.row.agent}) : t('agentViewNoConversation')}</p>
      <div className="button-row">
        <button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button>
        <button type="button" onClick={() => setManual(true)}>{t('agentViewChooseTranscript')}</button>
      </div>
    </div>}
    {manual && <p className="security-note">{t('agentViewManualNotice')}</p>}
    {reader && !terminalInput && <p className="agent-view-note">{t('agentViewStageOnly')}</p>}
    {reader && <ChatPanel key={manual ? 'manual' : JSON.stringify(binding.kind === 'bound' && binding.conversation)} sessionId={sessionId} shown={shown}
      bound={!manual && binding.kind === 'bound' ? binding.conversation : undefined} timeline onTurnStart={setTurnStart} onOpenTerminal={onShowTerminal} terminalInput={terminalInput} />}
  </section>;
}
