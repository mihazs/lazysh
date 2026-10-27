import {fireEvent,screen} from '@testing-library/react';
import {t} from '../i18n/core';
import {attachmentFile,attachmentReceipt,attachmentUploadedPath} from './attachmentData';
export async function selectChatAttachment(){
  fireEvent.click(screen.getByRole('button',{name:'Add attachment'}));
  fireEvent.change(screen.getByLabelText(t('attachmentChooseLabel')),{target:{files:[attachmentFile()]}});
  fireEvent.click(await screen.findByRole('button',{name:t('attachmentUpload')}));
}
/** Synthetic upload replies; no host or clipboard is accessed. */
export function attachmentReply(command:string){
  if(command==='upload_reserve')return {uploadId:attachmentReceipt};
  if(command==='upload_file')return {path:attachmentUploadedPath};
  if(command==='upload_cancel')return {outcome:'unknown_or_settled'};
  throw new Error('Unexpected attachment fixture command');
}
