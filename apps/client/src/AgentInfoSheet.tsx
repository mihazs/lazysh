import {X} from 'lucide-react';
import {formatNumber, t} from './i18n/core';
import type {AgentRoster, McpState} from './agentSession';
import './AgentInfoSheet.css';

const stateNames = {connected: 'agentInfoConnected', pending: 'agentInfoPending', failed: 'agentInfoFailed'} as const satisfies Record<McpState, string>;

/** What the session has loaded, read-only. The agent's own /mcp, /memory and /context screens are interactive pickers; those stay in the terminal. */
export default function AgentInfoSheet({info, onClose, onShowTerminal}: {info: AgentRoster; onClose: () => void; onShowTerminal: () => void}) {
  const section = (title: string, count: number | undefined, body: React.ReactNode) => <section>
    <h4>{title}{count !== undefined && <span> · {formatNumber(count)}</span>}</h4>{body}
  </section>;
  return <section className="agent-info-sheet" role="dialog" aria-label={t('agentInfoTitle')} onKeyDown={event => {if (event.key === 'Escape') onClose();}}>
    <header>
      <strong>{t('agentInfoTitle')}</strong>
      <button type="button" className="icon-button" aria-label={t('agentInfoClose')} title={t('agentInfoClose')} onClick={onClose} autoFocus><X size={18} aria-hidden="true"/></button>
    </header>
    {info.mcp && section(t('agentInfoMcp'), info.mcp.length, <ul>
      {info.mcp.map(server => <li key={server.name} data-state={server.state}><span>{server.name}</span>
        <small>{t(stateNames[server.state])}{server.toolCount ? ` · ${t('agentInfoTools', {count: server.toolCount})}` : ''}</small></li>)}
    </ul>)}
    {info.skills && section(t('agentInfoSkills'), info.skills.length, <p className="agent-info-chips">{info.skills.map(skill => <code key={skill}>{skill}</code>)}</p>)}
    {info.agents && section(t('agentInfoAgents'), info.agents.length, <p className="agent-info-chips">{info.agents.map(agent => <code key={agent}>{agent}</code>)}</p>)}
    {info.instructionFiles && section(t('agentInfoFiles'), info.instructionFiles.length, <ul>
      {info.instructionFiles.map(file => <li key={`${file.kind}:${file.name}`}><span>{file.name}</span>{file.kind && <small>{file.kind}</small>}</li>)}
    </ul>)}
    <p className="agent-info-note">{t('agentInfoReadOnly')} <button type="button" className="subtle-button" onClick={() => {onClose(); onShowTerminal();}}>{t('agentViewTerminal')}</button></p>
  </section>;
}
