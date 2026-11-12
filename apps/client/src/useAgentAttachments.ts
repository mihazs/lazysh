import {useEffect,useMemo,useRef,useState} from 'react';
import {useProtectedApi} from './access';
import {api as nativeApi} from './bridge';
import {checkAttachment,imageSize} from './attachment';
import {attachmentPathText} from './attachmentPaste';
import {atomicComposerEdit,expandComposerDraft,insertComposerToken,liveComposerAttachments,nextComposerAttachmentNumber,removeComposerToken,snapComposerSelection,type ComposerAttachment,type StagedComposerAttachment} from './composerTokens';
import {captureUiError,LocalUiError,type UiErrorCause} from './i18n/localError';
import {useHostUpload} from './useHostUpload';

/** The files each unsent draft refers to through `[Image #n]` / `[File #n]`: they live as long as the draft does. */
const held=new Map<string,readonly ComposerAttachment[]>();

/** Uploaded files in the Agent composer, as the terminal composer holds them: a numbered token in the draft that stays whole
 * under any edit and becomes the host path the upload returned only when the draft is sent. Pasting or dropping a file uploads it
 * through the same attachment path as the paperclip. */
export function useAgentAttachments({key,sessionId,draft,caret,limit,edit,place}:{
  key:string;sessionId:string;draft:string;caret:number;limit:number;
  /** Replace the whole draft. */
  edit:(next:string)=>void;
  /** Put the caret here once the replaced draft is on screen. */
  place:(caret:number)=>void;
}) {
  const [all,setAll]=useState(()=>held.get(key)??[]);
  const [error,setError]=useState<UiErrorCause>('');
  const api=useProtectedApi(nativeApi);
  const job=useHostUpload(api,sessionId,failure=>setError(captureUiError(failure)));
  const latest=useRef({draft,caret,all,key});latest.current={draft,caret,all,key};
  const before=useRef<{value:string;attachments:readonly ComposerAttachment[]}|null>(null);
  const lastCaret=useRef<number|undefined>(undefined);
  const save=(next:readonly ComposerAttachment[])=>{if(next.length)held.set(latest.current.key,next);else held.delete(latest.current.key);latest.current.all=next;setAll(next);};
  useEffect(()=>{setAll(held.get(key)??[]);setError('');},[key]);
  // A sent or cleared draft takes its attachments with it, so the next one numbers from one again.
  useEffect(()=>{if(!draft && all.length)save([]);},[draft,all]);
  const list=useMemo(()=>liveComposerAttachments(draft,all),[draft,all]);
  const expanded=useMemo(()=>{try{return expandComposerDraft(draft,list);}catch{return '';}},[draft,list]);
  /** Add an uploaded file as a token at the caret; throws a `LocalUiError` for a path the terminal cannot receive literally. */
  function add(staged:StagedComposerAttachment) {
    attachmentPathText(staged.path);
    const {draft,caret,all}=latest.current;
    const attachment:ComposerAttachment={...staged,number:nextComposerAttachmentNumber(draft,all)};
    const inserted=insertComposerToken(draft,caret,attachment,liveComposerAttachments(draft,all));
    if(inserted.value.length>limit)throw new LocalUiError('terminalDraftLimit');
    // Several files can arrive before the next render, so the next insertion starts from this one.
    latest.current.draft=inserted.value;latest.current.caret=inserted.caret;
    save([...all,attachment]);edit(inserted.value);place(inserted.caret);
  }
  async function upload(files:readonly File[]) {
    if(job.active())return;
    setError('');
    for(const file of files) {
      try {
        checkAttachment(file);
        const bytes=new Uint8Array(await file.arrayBuffer());
        const size=imageSize(bytes);
        if(size && file.type && file.type!==size.mime && file.type!=='application/octet-stream')throw new LocalUiError('attachmentTypeMismatch');
        const image=!!size || file.type.startsWith('image/');
        const preview=image?new Blob([bytes],{type:size?.mime??file.type}):undefined;
        await job.start(async()=>({path:file.name,bytes,temporary:true}),path=>add({kind:image?'image':'file',path,name:file.name,preview}));
      } catch(failure) {setError(captureUiError(failure));return;}
    }
  }
  return {
    list,expanded,error,busy:job.busy,add,upload,
    dismiss:()=>setError(''),
    remove:(attachment:ComposerAttachment)=>edit(removeComposerToken(latest.current.draft,attachment)),
    /** An edit that touches part of a token removes the whole token; IME composition is corrected once it commits. */
    change(next:string,composing:boolean) {
      if(composing){edit(next);return;}
      const corrected=atomicComposerEdit(latest.current.draft,next,list);
      edit(corrected.value);
      if(corrected.caret!==undefined)place(corrected.caret);
    },
    compose:{
      begin:()=>{before.current={value:latest.current.draft,attachments:list};},
      end(committed:string) {
        const start=before.current;before.current=null;
        if(!start)return;
        const corrected=atomicComposerEdit(start.value,committed,start.attachments);
        if(corrected.caret===undefined)return;
        edit(corrected.value);place(corrected.caret);
      },
    },
    /** Keep the caret and selection outside a token. */
    snap(element:HTMLTextAreaElement) {
      if(!list.length){lastCaret.current=element.selectionEnd;return;}
      const snapped=snapComposerSelection(element.value,list,element.selectionStart,element.selectionEnd,lastCaret.current);
      if(snapped.start!==element.selectionStart || snapped.end!==element.selectionEnd)element.setSelectionRange(snapped.start,snapped.end);
      lastCaret.current=snapped.end;
    },
  };
}
