import type {ReactNode} from 'react';

/** Optional technical detail of a tool panel behind one closed 44px line; trust, consent and credential text stays outside it. */
export default function ToolHelp({label,children}:{label:string;children:ReactNode}){
  return <details className="tool-help"><summary>{label}</summary><p>{children}</p></details>;
}
