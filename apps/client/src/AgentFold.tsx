import {useState, type ReactNode} from 'react';

/** The folded activity of a turn. Its rows are drawn the first time it is opened: a conversation of finished turns opens with
 * only the prompts and answers in the DOM, and the tool cards and intermediate text appear when someone looks at them. `reveal`
 * draws them without opening the fold, for a search that has to find the text of a row. */
export default function AgentFold({summary, reveal = false, children}: {summary: string; reveal?: boolean; children: () => ReactNode}) {
  const [opened, setOpened] = useState(false);
  return <details className="agent-turn-activity" onToggle={event => {if (event.currentTarget.open) setOpened(true);}}><summary>{summary}</summary>{(opened || reveal) && children()}</details>;
}
