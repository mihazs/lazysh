import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it} from 'vitest';

it('keeps interface text and accessible attributes catalogued throughout the covered workflow',()=>{
  const files=['App','PreferencesPanel','ChordBuilder','ThemeImportPanel','ThemeLinkPanel','AppIconPanel','AccessPanel','AccessShell','ChatPanel','UsagePanel','NotificationPanel','SessionTools','RepositoryPanel','CodePreview','PreviewPanel','PreviewFrame','CloudVoiceSettingsPanel','VoiceHistoryPanel','VoicePanel','AgentPanel','ApprovalPanel','CompanionSettingsPanel','AttachmentPanel','SharePanel','DevicePanel','PushSettingsPanel'];
  const literalExamples=new Set(['Android','/private/tmp/lazysh-idb/idb.sock','Whisper','Cloud · gpt-transcribe','MiB','https://voice.example.com','https://files.example.com','IPv4','IPv6','/host/session.jsonl','l','lazysh','SSH','ET','Mosh','Eternal Terminal','Ctrl','C-b, T','workstation.local','agent $ ready for review','lazysh 0123456789 · 中文 日本語 한국어']);
  const uncatalogued:string[]=[];
  for(const file of files) {
    const source=readFileSync(new URL(`../${file}.tsx`,import.meta.url),'utf8');
    const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const examine=(text:string,node:ts.Node)=>{
      const normalized=text.replace(/\s+/g,' ').trim();
      if(/[A-Za-z]/.test(normalized)&&!literalExamples.has(normalized)) uncatalogued.push(`${file}:${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line+1}: ${normalized}`);
    };
    function visit(node:ts.Node) {
      if(ts.isJsxText(node)) {
        const tag=ts.isJsxElement(node.parent)?node.parent.openingElement.tagName.getText(parsed):'';
        if(!['pre','code'].includes(tag))examine(node.text,node);
      }
      if(ts.isJsxAttribute(node)&&['aria-label','title','placeholder','alt'].includes(node.name.getText(parsed))&&node.initializer&&ts.isStringLiteral(node.initializer))examine(node.initializer.text,node);
      ts.forEachChild(node,visit);
    }
    visit(parsed);
  }
  expect(uncatalogued).toEqual([]);
});
