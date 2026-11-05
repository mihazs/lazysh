import {Info} from 'lucide-react';
import {t,formatDateTime} from './i18n/core';
import type {AccessLease} from './access';
import type {AgentSession} from './AgentPanel';
import type {HerdrTree,LiveAgent,ReportedSessionRef} from './useHerdrNavigation';

export type ReportedSessionSource={host:string|undefined;available:boolean;rows:readonly AgentSession[];lease:AccessLease};
const reportLabels={codex:'Codex',claude:'Claude Code',opencode:'OpenCode'} as const;
const reportedStatuses={working:'working',needs_attention:'blocked',done:'done'} as const;
function readableReports(reports:ReportedSessionSource|undefined,sessionId:string):reports is ReportedSessionSource {
  return !!reports?.available && reports.host===sessionId && reports.lease.current();
}
function matchingReports(reference:ReportedSessionRef,reports:ReportedSessionSource,sessionId:string) {
  return readableReports(reports,sessionId)?reports.rows.filter(report=>report.agent===reportLabels[reference.agent] && report.sessionId===reference.value):[];
}
export function reportedSessionCounts(rows:readonly LiveAgent[]) {
  const references=new Map<string,number>();
  for(const row of rows)if(row.agent_session){
    const key=JSON.stringify([row.agent_session.agent,row.agent_session.value]);
    references.set(key,(references.get(key)??0)+1);
  }
  return references;
}
/**
 * Herdr's own state always wins. Only an Unknown agent pane takes a lifecycle
 * state, and only from exact event context: the pane's Herdr-reported session
 * ID is unique among live panes and matches exactly one companion report from
 * this connection. Anything else stays Unknown.
 */
export function withReportedStatus<T extends {rows:LiveAgent[];snapshot?:HerdrTree}>(data:T,reports:ReportedSessionSource|undefined,sessionId:string):T {
  if(!readableReports(reports,sessionId) || !data.rows.some(row=>row.agent_status==='unknown' && row.agent_session))return data;
  const counts=reportedSessionCounts(data.rows);
  let changed=false;
  const rows=data.rows.map(row=>{
    const reference=row.agent_session;
    if(row.agent_status!=='unknown' || !reference || counts.get(JSON.stringify([reference.agent,reference.value]))!==1)return row;
    const matches=matchingReports(reference,reports,sessionId);
    if(matches.length!==1)return row;
    changed=true;
    return {...row,agent_status:reportedStatuses[matches[0].state],status_source:'report' as const};
  });
  if(!changed)return data;
  const status=(pane:HerdrTree['panes'][number])=>rows.find(row=>row.status_source && row.pane_id===pane.pane_id && row.terminal_id===pane.terminal_id)?.agent_status;
  const snapshot=data.snapshot && {...data.snapshot,panes:data.snapshot.panes.map(pane=>{const value=status(pane);return value?{...pane,agent_status:value}:pane;})};
  return {...data,rows,snapshot};
}
/** A cross-reference to host reports, never evidence of current pane ownership. */
export default function HerdrSessionDetails({reference,count,sessionId,available,reports}:{reference:ReportedSessionRef;count:number;sessionId:string;available:boolean;reports?:ReportedSessionSource}) {
  const readable=available && readableReports(reports,sessionId);
  const matches=readable?matchingReports(reference,reports,sessionId):[];
  const report=matches.length===1?matches[0]:undefined;
  return <details className="herdr-report-reference"><summary title={t('herdrReferenceDetails')}><Info size={16} aria-hidden="true"/><span className="sr-only">{t('herdrReferenceDetails')}</span></summary>
    <p>{t('herdrReferenceUnverified')}</p><code>{reference.agent}: {reference.value}</code>
    {count>1 && <p>{t('herdrReferenceShared',{count})}</p>}
    {report?<><p>{t(({working:'agentsWorking',needs_attention:'agentsNeedsYou',done:'agentsDone'} as const)[report.state])}</p><p>{t('agentsReportProject')}: <code>{report.project}</code></p><time dateTime={report.updatedAt}>{t('agentsReported',{time:formatDateTime(new Date(report.updatedAt))})}</time></>:<p>{t(readable && matches.length===0?'herdrReferenceNoMatch':'herdrReferenceUnavailable')}</p>}
  </details>;
}
