import {AlertTriangle,WifiOff,X} from 'lucide-react';
import {t} from './i18n/core';
import type {TerminalProblem} from './ChatTerminalInput';

type Action='retry'|'stage'|'terminal';
type Title='agentNoticeNotSentTitle'|'agentNoticeOfflineTitle'|'agentNoticeUnconfirmedTitle';
type Reason='agentNoticeGuard'|'agentComposerWrongPane'|'agentNoticeBlocked'|'agentNoticeChanged'|'agentNoticeBusy'|'agentNoticeOffline'|'agentNoticeRejected'|'agentNoticeInvalid'|'agentNoticeUnconfirmed'|'agentNoticeOther';
type Copy=Readonly<{title?:Title;reason:Reason;actions:readonly Action[]}>;
const notSent:Copy={reason:'agentNoticeOther',actions:['retry','stage']};
/** One plain-language entry per way a send can fail; the first action is the one that gets the person unstuck. */
const copies:Partial<Record<TerminalProblem['key'],Copy>>={
  chatHerdrUnavailable:{reason:'agentNoticeGuard',actions:['stage','terminal']},
  agentComposerWrongPane:{reason:'agentComposerWrongPane',actions:['stage','terminal']},
  chatHerdrBlocked:{reason:'agentNoticeBlocked',actions:['terminal']},
  chatTerminalStale:{reason:'agentNoticeChanged',actions:['retry','terminal']},
  chatTerminalBusy:{reason:'agentNoticeBusy',actions:['retry']},
  chatHerdrOffline:{title:'agentNoticeOfflineTitle',reason:'agentNoticeOffline',actions:['retry','stage']},
  chatHerdrRejected:{reason:'agentNoticeRejected',actions:['retry','stage']},
  chatTerminalInvalid:{reason:'agentNoticeInvalid',actions:['stage']},
  chatTerminalInvalidDraft:{reason:'agentNoticeInvalid',actions:['stage']},
};
const unconfirmed:Copy={title:'agentNoticeUnconfirmedTitle',reason:'agentNoticeUnconfirmed',actions:['terminal','stage']};

/** The single inline notice of the composer for a refused or unconfirmed send. The draft stays in the field. */
export default function AgentComposerNotice({problem,busy,canStage,onRetry,onStage,onOpenTerminal,onDismiss}:{
  problem:TerminalProblem;busy:boolean;canStage:boolean;onRetry:()=>void;onStage:()=>void;onOpenTerminal?:()=>void;onDismiss:()=>void;
}) {
  // After a failure while writing, delivery is unknown, so nothing here resends on its own.
  const unknown=!!problem.uncertain || problem.key==='chatHerdrUncertain';
  const copy=unknown?unconfirmed:copies[problem.key] ?? notSent;
  const offline=copy.title==='agentNoticeOfflineTitle';
  const run:Record<Action,{label:'agentReceiptRetry'|'chatStage'|'chatOpenTerminal';onClick:()=>void;disabled?:boolean}|undefined>={
    retry:{label:'agentReceiptRetry',onClick:onRetry,disabled:busy},
    stage:canStage?{label:'chatStage',onClick:onStage}:undefined,
    terminal:onOpenTerminal?{label:'chatOpenTerminal',onClick:onOpenTerminal}:undefined,
  };
  const actions=copy.actions.map(name=>run[name]).filter(action=>!!action);
  const details=[problem.uncertain==='paste'?t('chatTerminalPasteUncertain'):problem.uncertain?t('chatTerminalUncertain'):'',problem.raw ?? ''].filter(Boolean);
  const Icon=offline?WifiOff:AlertTriangle;
  return <div role="alert" className="agent-composer-notice" data-tone={unknown?'danger':'warning'}>
    <Icon size={18} aria-hidden="true"/>
    <div className="agent-composer-notice-text"><strong>{t(copy.title ?? 'agentNoticeNotSentTitle')}</strong><span>{t(copy.reason)}</span></div>
    {actions.length>0 && <div className="agent-composer-notice-actions">{actions.map((action,index)=><button key={action.label} type="button" className={index===0?'primary-button':'subtle-button'} disabled={action.disabled} onClick={action.onClick}>{t(action.label)}</button>)}</div>}
    <button type="button" className="icon-button agent-composer-notice-close" aria-label={t('appDismiss')} title={t('appDismiss')} onClick={onDismiss}><X size={16} aria-hidden="true"/></button>
    {details.length>0 && <details className="agent-composer-notice-details"><summary>{t('agentNoticeDetails')}</summary>{details.map(line=><p key={line}>{line}</p>)}</details>}
  </div>;
}
