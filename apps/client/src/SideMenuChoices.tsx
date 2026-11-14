import {type ReactNode, useEffect, useRef} from 'react';

/** Calls `onChoose` after any click inside, including the terminal controls that React portals into it: those bubble through the terminal in the React tree, so only a DOM listener sees them. */
export function SideMenuChoices({onChoose, children}: {onChoose: () => void; children: ReactNode}) {
  const node = useRef<HTMLDivElement>(null);
  const choose = useRef(onChoose);
  choose.current = onChoose;
  useEffect(() => {
    const element = node.current;
    const click = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest('button')) choose.current(); };
    element?.addEventListener('click', click);
    return () => element?.removeEventListener('click', click);
  }, []);
  return <div ref={node} className="sidebar-session-choices">{children}</div>;
}
