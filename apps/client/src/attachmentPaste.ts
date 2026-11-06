import {LocalUiError} from './i18n/localError';
import {shellPath} from './attachment';
import {dictationInput} from './voiceDelivery';

export type AttachmentPathPaste={sessionId:string;path:string;claim:()=>boolean};

/**
 * The shell-quoted text for a path an upload returned: a single-line absolute
 * path without `.`/`..` segments, C0/C1 controls or more than 4096 bytes.
 * Every place that types an uploaded path into a terminal shares this rule.
 */
export function attachmentPathText(path:unknown):string {
  try {
    if(typeof path!=='string' || (!path.startsWith('/')&&!/^[A-Za-z]:\//.test(path))
      || path.endsWith('/') || path.split('/').some(part=>part==='.'||part==='..')
      || new TextEncoder().encode(path).length>4096)throw new Error();
    return dictationInput(shellPath(path),false);
  } catch {throw new LocalUiError('attachmentPasteInvalid');}
}

/** Validate literal payload before adding only the terminal's trusted paste framing. */
export function attachmentTerminalInput(path:unknown,bracketed:boolean,ignoreBracketed=false):string {
  const text=attachmentPathText(path);
  return bracketed&&!ignoreBracketed?`\x1b[200~${text}\x1b[201~`:text;
}
