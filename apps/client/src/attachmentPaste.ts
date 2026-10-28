import {LocalUiError} from './i18n/localError';
import {shellPath} from './attachment';
import {dictationInput} from './voiceDelivery';

export type AttachmentPathPaste={sessionId:string;path:string;claim:()=>boolean};

/** Validate literal payload before adding only the terminal's trusted paste framing. */
export function attachmentTerminalInput(path:unknown,bracketed:boolean,ignoreBracketed=false):string {
  try {
    if(typeof path!=='string' || (!path.startsWith('/')&&!/^[A-Za-z]:\//.test(path))
      || path.endsWith('/') || path.split('/').some(part=>part==='.'||part==='..')
      || new TextEncoder().encode(path).length>4096)throw new Error();
    const text=dictationInput(shellPath(path),false);
    return bracketed&&!ignoreBracketed?`\x1b[200~${text}\x1b[201~`:text;
  } catch {throw new LocalUiError('attachmentPasteInvalid');}
}
