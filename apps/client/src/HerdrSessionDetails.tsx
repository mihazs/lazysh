import {t,formatDateTime} from './i18n/core';
import type {AccessLease} from './access';
import type {AgentSession} from './AgentPanel';
import type {LiveAgent,ReportedSessionRef} from './useHerdrNavigation';

export type ReportedSessionSource={host:string|undefined;available:boolean;rows:readonly AgentSession[];lease:AccessLease};
export function reportedSessionCounts(rows:readonly LiveAgent[]) {
  const references=new Map<string,number>();
  for(const row of rows)if(row.agent_session){
    const key=JSON.stringify([row.agent_session.agent,row.agent_session.value]);
    references.set(key,(references.get(key)??0)+1);
  }
  return references;
}
/** A cross-reference to host reports, never evidence of current pane ownership. */
export default function HerdrSessionDetails({reference,count,sessionId,available,reports}:{reference:ReportedSessionRef;count:number;sessionId:string;available:boolean;reports?:ReportedSessionSource}) {
  const labels={codex:'Codex',claude:'Claude Code',opencode:'OpenCode'};
  const readable=available && reports?.available && reports.host===sessionId && reports.lease.current();
  const matches=readable?reports.rows.filter(report=>report.agent===labels[reference.agent] && report.sessionId===reference.value):[];
  const report=matches.length===1?matches[0]:undefined;
  return <details><summary>{t('herdrReferenceDetails')}</summary>
    <p>{t('herdrReferenceUnverified')}</p><code>{reference.agent}: {reference.value}</code>
    {count>1 && <p>{t('herdrReferenceShared',{count})}</p>}
    {report?<><p>{t(({working:'agentsWorking',needs_attention:'agentsNeedsYou',done:'agentsDone'} as const)[report.state])}</p><p>{t('agentsReportProject')}: <code>{report.project}</code></p><time dateTime={report.updatedAt}>{t('agentsReported',{time:formatDateTime(new Date(report.updatedAt))})}</time></>:<p>{t(readable && matches.length===0?'herdrReferenceNoMatch':'herdrReferenceUnavailable')}</p>}
  </details>;
}
