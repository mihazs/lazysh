import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it} from 'vitest';

it('keeps interface text and accessible attributes catalogued throughout the covered workflow',()=>{
  const files=['ThemeQrPanel','KeepAwakeControl','MultiplexerShortcuts','TerminalPane','SyncPanel','AboutPanel','App','PreferencesPanel','ToolbarKeysEditor','ToolbarPages','ChordBuilder','ThemeImportPanel','ThemeLinkPanel','AppIconPanel','AccessPanel','AccessShell','ChatPanel','AgentView','AgentPickerDock','UsagePanel','NotificationPanel','SessionTools','RepositoryPanel','CodePreview','CommandPalette','FilePreview','PreviewPanel','PreviewFrame','hostBrowser/HostBrowserInput','hostBrowser/HostBrowserControls','CloudVoiceSettingsPanel','VoiceHistoryPanel','VoicePanel','AgentPanel','AllHostsBoard','AgentReportParts','ApprovalPanel','ApprovalChoices','CompanionSettingsPanel','AttachmentPanel','SharePanel','DevicePanel','TmuxJumpPanel','PushSettingsPanel','MultiplexerPanel','MultiplexerHistory','ManagedHerdrPanel','HerdrPanel','HerdrWorkspaceCreateDialog','ZellijPanel','CredentialsPanel','AppleStatusPanel','WorkspaceToolsCarousel','ConnectionBanner','GestureTour','RemoteNotificationsPanel'];

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
