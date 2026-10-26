export const grokReceipt = (offset: number, length = offset, prefix = 'a', source = 'b') =>
  `g1:${source.repeat(64)}:${offset}:${length}:${prefix.repeat(64)}`;
export const grokFollowPage = (offset = 10, length = offset, text = 'Verified recorded text', prefix = 'a') => ({
  schemaVersion:1,agent:'grok-acp',view:'record_stream',nextOffset:offset,hasMore:false,
  checkpoint:grokReceipt(offset,length,prefix),
  messages:text ? [{id:`grok-record-${Math.max(0,offset-1)}`,role:'assistant',blocks:[{type:'text',text}]}] : [],
});
