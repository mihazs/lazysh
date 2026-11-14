import {expect, it, vi} from "vitest";
import {screen, waitFor, within} from "@testing-library/react";
import {t} from '../i18n/core';
import {transcriptAgents, type TranscriptAgentId} from '../transcriptSources';
import {tmuxChatReaderPage, tmuxChatReaderSource, tmuxChatReply} from './tmuxChat';
import {chooseWorkspaceTool, mocks, openConnection} from './appHarness';

export type ChatInputKind='plain'|'tmux'|'limited'|'unknown';

/**
 * The explicit terminal-input matrix (every transcript agent against a kind of Chat session). One case is a full
 * App mount, so the suite runs it as one file per kind and vitest runs those files in parallel.
 */
export function chatTerminalInputCases(kinds:readonly ChatInputKind[]) {
  it.each((Object.keys(transcriptAgents) as TranscriptAgentId[]).flatMap(agent=>kinds.map(kind=>({agent,kind}))))('offers explicit $agent terminal input only on an actual $kind Chat session and targets the exact display',async({agent,kind})=>{
    const source=tmuxChatReaderSource(agent);
    mocks.api.connect.mockResolvedValue({sessionId:'plain-control'});mocks.api.attachTmux.mockResolvedValue({sessionId:'retained-display'});
    mocks.invoke.mockImplementation((command,args)=>{
      if(command==='multiplexer_tree' && kind==='unknown' && args?.sessionId==='retained-display')return Promise.reject(new Error('discovery unavailable'));
      if(command==='multiplexer_tree')return Promise.resolve({tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[kind==='limited'?{kind:'tmux',version:'3.2a',support:'degraded',missing:['jump','confirmedInput']}:{kind:'tmux',version:'3.4',support:'full',missing:[]}],sessions:[{id:'$1',name:'work',windows:[]}]});
      if(command==='agent_transcript')return Promise.resolve(tmuxChatReaderPage(agent));
      if(command==='tmux_chat')return tmuxChatReply(command,args);
      return Promise.resolve(false);
    });
    const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
    if(kind!=='plain'){
      await chooseWorkspaceTool(user,'Sessions');await user.click(await screen.findByRole('button',{name:'Attach work'}));
      await waitFor(()=>expect(screen.getAllByRole('tab')).toHaveLength(2));
    }
    await chooseWorkspaceTool(user,'Transcript');await user.selectOptions(await screen.findByLabelText('Agent'),agent);const path=screen.getByLabelText('Transcript path');await user.click(path);await user.paste(source.path);
    if('transcriptSessionId' in source)await user.type(screen.getByLabelText('Transcript session ID'),source.transcriptSessionId);
    await user.click(screen.getByRole('button',{name:'Open transcript'}));
    await screen.findByRole('button',{name:t('chatRefreshMessages')});
    expect(mocks.invoke).toHaveBeenCalledWith('agent_transcript',{sessionId:kind!=='plain'?'retained-display':'plain-control',agent,path:source.path,offset:0,...('transcriptSessionId' in source?{transcriptSessionId:source.transcriptSessionId}:{})},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
    async function stage(text:string){
      const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
      try {await user.type(screen.getByLabelText('Draft for this terminal'),text);await user.click(screen.getByRole('button',{name:'Stage in terminal'}));}
      finally {window.removeEventListener('lazysh-prompt-draft',staged);}
      expect(staged).toHaveBeenCalledTimes(1);expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:kind!=='plain'?'retained-display':'plain-control',text});
    }
    expect(mocks.invoke.mock.calls.filter(([command])=>command==='tmux_chat')).toHaveLength(0);
    if(kind!=='tmux'){expect(screen.queryByRole('button',{name:t('chatTerminalChoose')})).toBeNull();await stage('manual fallback');expect(mocks.invoke.mock.calls.filter(([command])=>command==='tmux_chat')).toHaveLength(0);return;}
    await user.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));const input=screen.getByRole('region',{name:t('chatTerminalTitle')});
    await within(input).findByText('Agent work');expect(within(input).getByText('dev@home.local')).toBeTruthy();expect(within(input).getByText('Home / work')).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith('tmux_chat',{sessionId:'retained-display',action:{kind:'snapshot'}},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
    await user.click(within(input).getByRole('button',{name:t('chatTerminalConfirm')}));await user.type(screen.getByLabelText('Draft for this terminal'),'explicit input');
    await user.click(within(input).getByRole('button',{name:t('chatTerminalSend')}));await within(input).findByText(t('chatTerminalSent'));
    expect(mocks.invoke).toHaveBeenCalledWith('tmux_chat',expect.objectContaining({sessionId:'retained-display',action:expect.objectContaining({kind:'input',source,operation:1,input:{kind:'send',text:'explicit input'}})}),{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
    expect(mocks.api.write).not.toHaveBeenCalled();await stage('manual fallback');
  });
}
