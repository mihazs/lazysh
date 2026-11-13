import {ChatMarkdown} from './ChatInteraction';
import {formatCountdown} from './relativeTime';
import {t} from './i18n/core';
import './AgentThinking.css';

type Message = {timestamp?: string; blocks: {type: string; text?: string}[]};
type Turn = {prompt?: Message; event?: Message; activity: Message[]; answer?: Message};

/** The turn's thinking paragraphs and, when the records carry times, how long the agent thought: for each message with
 * thinking, the time since the record before it. Reasoning tokens are not recorded, so none are shown. */
export function turnThinking(turn: Turn) {
  const messages = [turn.event ?? turn.prompt, ...turn.activity, turn.answer].filter((message): message is Message => !!message);
  const paragraphs: string[] = [];
  let milliseconds: number | undefined;
  messages.forEach((message, index) => {
    const thoughts = message.blocks.filter(block => block.type === 'thinking' && block.text?.trim()).map(block => block.text!.trim());
    if (!thoughts.length) return;
    paragraphs.push(...thoughts);
    const end = Date.parse(message.timestamp ?? ''), start = Date.parse(messages[index - 1]?.timestamp ?? '');
    if (end >= start) milliseconds = (milliseconds ?? 0) + end - start;
  });
  return {paragraphs, milliseconds};
}

/** One **Thought for 12 s** row per turn, expanding to the thinking as Markdown; nothing for a turn without thinking. */
export default function AgentThinking({turn}: {turn: Turn}) {
  const {paragraphs, milliseconds} = turnThinking(turn);
  if (!paragraphs.length) return null;
  const seconds = milliseconds === undefined ? undefined : Math.round(milliseconds / 1000);
  return <details className="agent-thinking">
    <summary>{seconds === undefined ? t('agentThinking') : t('agentThoughtFor', {time: seconds < 60 ? `${seconds} s` : formatCountdown(seconds * 1000)})}</summary>
    {paragraphs.map((text, index) => <ChatMarkdown key={index} text={text} />)}
  </details>;
}
