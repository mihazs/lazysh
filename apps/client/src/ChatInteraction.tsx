import {memo} from 'react';
import Markdown from 'react-markdown';
import QuestionAnswers, {answerable} from './AgentQuestionAnswer';
import type {DialogAnswerer} from './ChatTerminalInput';
import {ChatRich} from './ChatRich';
import {t} from './i18n/core';
import {LocalUiError} from './i18n/localError';
import './ChatInteraction.css';

export type PlanStatus='pending'|'in_progress'|'completed'|'cancelled';
type Option=Readonly<{label:string;description?:string}>;
type Question=Readonly<{question:string;header?:string;options:readonly Option[];multiple:boolean}>;
export type Card=Readonly<
  {kind:'plan';entries:readonly Readonly<{text:string;status:PlanStatus}>[];explanation?:string}
  | {kind:'proposed_plan';text?:string}
  | {kind:'question';questions:readonly Question[]}
  | {kind:'error';cause:ErrorCause}
>;
export type ErrorCause='rate_limit'|'server_error'|'invalid_request'|'unknown';
const errorCauses:readonly string[]=['rate_limit','server_error','invalid_request','unknown'];
export type Activity='working'|'waiting'|'idle'|'stopped';

const cardAgents=['claude','codex','opencode'];
const maxText=16*1024;
const invalid=()=>new LocalUiError('chatInvalidCard');
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))throw invalid();
  const keys=Object.keys(value);
  if(required.some(key=>!Object.hasOwn(value,key)) || keys.some(key=>!required.includes(key) && !optional.includes(key)))throw invalid();
  return value as Record<string,unknown>;
}
function text(value:unknown,optional=false):string|undefined {
  if(optional && value===undefined)return undefined;
  if(typeof value!=='string' || !value.trim() || value.length>maxText)throw invalid();
  return value;
}
function list(value:unknown,limit:number,allowEmpty=false):unknown[] {
  if(!Array.isArray(value) || value.length>limit || (!allowEmpty && value.length===0))throw invalid();
  return value;
}

/** Cards are display-only projections the companion attaches to recorded tool calls. */
export function parseCard(value:unknown,context:{agent:string;view?:string;type:string}):Card {
  if(!cardAgents.includes(context.agent))throw invalid();
  const kind=exact(value,['kind'],['entries','explanation','text','questions','cause']).kind;
  const textBlock=context.type==='text';
  if(kind==='error') {
    // Claude Code writes a failed API call as an assistant text record.
    const card=exact(value,['kind','cause']);
    if(context.agent!=='claude' || !textBlock || !errorCauses.includes(card.cause as string))throw invalid();
    return {kind,cause:card.cause as ErrorCause};
  }
  if(textBlock && !(context.agent==='codex' && context.view==='active_branch' && kind==='proposed_plan'))throw invalid();
  if(!textBlock && context.type!=='tool_use')throw invalid();
  if(kind==='plan') {
    const card=exact(value,['kind','entries'],['explanation']);
    const statuses=context.agent==='opencode'?['pending','in_progress','completed','cancelled']:['pending','in_progress','completed'];
    return {kind,explanation:text(card.explanation,true),entries:list(card.entries,100).map(entry=>{
      const row=exact(entry,['text','status']);
      if(!statuses.includes(row.status as string))throw invalid();
      return {text:text(row.text)!,status:row.status as PlanStatus};
    })};
  }
  if(kind==='proposed_plan') {
    const card=exact(value,['kind'],textBlock?[]:['text']);
    return {kind,text:textBlock?undefined:text(card.text)};
  }
  if(kind==='question') {
    const card=exact(value,['kind','questions']);
    return {kind,questions:list(card.questions,20).map(entry=>{
      const row=exact(entry,['question','options','multiple'],['header']);
      if(typeof row.multiple!=='boolean')throw invalid();
      return {question:text(row.question)!,header:text(row.header,true),multiple:row.multiple,options:list(row.options,20,true).map(option=>{
        const item=exact(option,['label'],['description']);
        return {label:text(item.label)!,description:text(item.description,true)};
      })};
    })};
  }
  throw invalid();
}

/** Turn state recorded in a conversation branch; absent means unknown. */
export function parseActivity(value:unknown,agent:string,view?:string):Activity|undefined {
  if(value===undefined)return undefined;
  if(!cardAgents.includes(agent) || view!=='active_branch' || !['working','waiting','idle','stopped'].includes(value as string))
    throw new LocalUiError('chatInvalidActivity');
  return value as Activity;
}

/** Markdown without raw HTML, remote images or active links; `image` replaces each image. */
export const ChatMarkdown=memo(function ChatMarkdown({text,image}:{text:string;image?:string}) {
  return <Markdown components={{img:()=> <span>{image ?? t('chatImagePlaceholder')}</span>,a:({children})=> <span>{children}</span>}}>{text}</Markdown>;
});

const planStatus={pending:'chatPlanPending',in_progress:'chatPlanInProgress',completed:'chatPlanCompleted',cancelled:'chatPlanCancelled'} as const;
const activityText={working:'chatActivityWorking',waiting:'chatActivityWaiting',idle:'chatActivityIdle',stopped:'chatActivityStopped'} as const;

export function ChatActivity({activity}:{activity?:Activity}) {
  return <p className="chat-activity" role="status" data-activity={activity ?? 'unknown'}>
    <span className="chat-activity-dot" aria-hidden="true" />
    <span>{t(activity?activityText[activity]:'chatActivityUnknown')}</span>
    <small>{t('chatActivityExplanation')}</small>
  </p>;
}

const errorNext={rate_limit:'chatErrorRateLimit',server_error:'chatErrorServer',invalid_request:'chatErrorRequest',unknown:'chatErrorUnknown'} as const;

/** `answerer` makes a single-question card answerable here; without it the card only shows the question. */
export function ChatCard({card,body,answered,onOpenTerminal,answerer}:{card:Card;body?:string;answered?:boolean;onOpenTerminal?:()=>void;answerer?:DialogAnswerer}) {
  if(card.kind==='plan')return <section className="chat-card chat-plan-card" aria-label={t('chatPlanTitle')}>
    <h5>{t('chatPlanTitle')}</h5>
    {card.explanation && <p>{card.explanation}</p>}
    <ol className="chat-plan-entries">
      {card.entries.map((entry,index)=> <li key={index} data-status={entry.status}>
        <span className="chat-plan-status">{t(planStatus[entry.status])}</span>
        <span>{entry.text}</span>
      </li>)}
    </ol>
  </section>;
  if(card.kind==='error')return <section className="chat-card chat-error-card" role="alert" aria-label={t('chatErrorTitle')}>
    <h5>{t('chatErrorTitle')}</h5>
    <ChatMarkdown text={body ?? ''} />
    <p>{t(errorNext[card.cause])}</p>
  </section>;
  if(card.kind==='proposed_plan')return <section className="chat-card chat-proposed-plan-card" aria-label={t('chatProposedPlanTitle')}>
    <h5>{t('chatProposedPlanTitle')}</h5>
    <ChatRich text={card.text ?? body ?? ''} />
  </section>;
  return <section className="chat-card chat-question-card" aria-label={t('chatQuestionTitle')}>
    <h5>{t('chatQuestionTitle')}</h5>
    {card.questions.map((question,index)=> <fieldset key={index} disabled>
      <legend>{question.header ? `${question.header}: ` : ''}{question.question}</legend>
      {question.options.length>0 ? <ul className="chat-question-options">
        {question.options.map((option,optionIndex)=> <li key={optionIndex}>
          <strong>{option.label}</strong>{option.description && <span>{option.description}</span>}
        </li>)}
      </ul> : <p>{t('chatQuestionFreeform')}</p>}
      {question.multiple && <p>{t('chatQuestionMultiple')}</p>}
    </fieldset>)}
    {answerer && !answered && answerable(card.questions)
      ? <QuestionAnswers questions={card.questions} answerer={answerer}/>
      : <p role="note">{t(answered ? 'chatQuestionAnswered' : 'chatQuestionUnanswered')} {t('chatQuestionTerminal')}</p>}
    {onOpenTerminal && !answered && <button type="button" onClick={onOpenTerminal}>{t('chatOpenTerminal')}</button>}
  </section>;
}
