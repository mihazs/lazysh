import {useEffect, useState} from 'react';
import type {DialogAnswer, DialogAnswerer} from './ChatTerminalInput';
import {t} from './i18n/core';

type Question = Readonly<{question: string; multiple: boolean; options: readonly Readonly<{label: string}>[]}>;
// Claude Code numbers its options with digits and adds "Type something" after them: at most 8 options leave it a digit.
export const answerable = (questions: readonly Question[]) => questions.every(question => question.options.length >= 1 && question.options.length <= 8);
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Answers the open AskUserQuestion dialog question by question with the keys the terminal takes for it: an option's digit,
 * the Submit row, or the free-text row and the typed answer; then the review page's "Submit answers" when the dialog has one
 * (several questions, or a multi-select). The answer is recorded when the agent's transcript shows it. */
export default function QuestionAnswers({questions, answerer}: {questions: readonly Question[]; answerer: DialogAnswerer}) {
  const [index, setIndex] = useState(0);
  const review = questions.length > 1 || questions[0].multiple;
  return <QuestionAnswer key={index} question={questions[index]} answerer={answerer} review={review && index === questions.length - 1}
    onSent={index < questions.length - 1 ? () => setIndex(index + 1) : undefined} progress={questions.length > 1 ? `${index + 1}/${questions.length}` : undefined}/>;
}

function QuestionAnswer({question, answerer, review, onSent, progress}: {question: Question; answerer: DialogAnswerer; review: boolean; onSent?: () => void; progress?: string}) {
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState<readonly number[]>([]);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const of = question.options.length;
  // A tap that landed as the card appeared must not answer.
  useEffect(() => {const timer = setTimeout(() => setReady(true), 400); return () => clearTimeout(timer);}, []);
  async function send(steps: readonly (DialogAnswer | 'review')[]) {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    for (const step of steps) {
      // The review page needs a moment to draw before its digit means "Submit answers".
      if (step === 'review') await pause(600);
      if (!await answerer(step === 'review' ? {kind: 'select', option: 1, of: 2} : step)) {setState('failed'); return;}
    }
    setState('sent');
    onSent?.();
  }
  const busy = !ready || state === 'sending' || state === 'sent';
  return <div className="chat-question-answer">
    {progress && <p>{progress} · {question.question}</p>}
    {question.multiple ? <>
      <ul className="chat-question-options">{question.options.map((option, index) => <li key={index}>
        <label><input type="checkbox" disabled={busy} checked={checked.includes(index)} onChange={event => setChecked(event.target.checked ? [...checked, index] : checked.filter(item => item !== index))}/> {option.label}</label>
      </li>)}</ul>
      <button type="button" disabled={busy || !checked.length} onClick={() => void send([...[...checked].sort().map((index): DialogAnswer => ({kind: 'select', option: index + 1, of})), {kind: 'submit', of}, ...(review ? ['review' as const] : [])])}>{t('agentAnswerSubmit')}</button>
    </> : <div className="chat-question-choices">{question.options.map((option, index) =>
      <button type="button" key={index} disabled={busy} onClick={() => void send([{kind: 'select', option: index + 1, of}, ...(review ? ['review' as const] : [])])}>{option.label}</button>)}</div>}
    <form className="chat-question-other" onSubmit={event => {event.preventDefault(); if (!busy && text.trim()) void send([{kind: 'select', option: of + 1, of: of + 1}, {kind: 'send', text: text.trim()}, ...(review ? ['review' as const] : [])]);}}>
      <input type="text" aria-label={t('agentAnswerOther')} maxLength={1000} disabled={busy} value={text} onChange={event => setText(event.target.value)}/>
      <button type="submit" disabled={busy || !text.trim()}>{t('agentAnswerSendOther')}</button>
    </form>
    {state === 'sent' && <p role="status">{t('agentAnswerSent')}</p>}
    {state === 'failed' && <p role="alert">{t('agentAnswerFailed')}</p>}
  </div>;
}
