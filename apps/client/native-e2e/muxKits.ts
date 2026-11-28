import {SshFixture} from '../../../tests/support/sshFixture';
import {tmuxClients,tmuxProbe,type PaneProbe} from './tmuxPane';
import {pinnedZellij,zellijClients,zellijProbe} from './zellijPane';

/** What a native GUI case needs from a multiplexer to enter it, name its pane and count the clients attached to it. */
export type MuxKit={
  kind:'tmux'|'zellij';
  /** The multiplexer's name as the Sessions panel spells it before its version. */
  label:'tmux'|'Zellij';
  start:()=>Promise<SshFixture>;
  probe:PaneProbe;
  clients:(ssh:SshFixture,name:string)=>Promise<number>;
  /** The host's own version line, as the Sessions panel shows its version. */
  version:(ssh:SshFixture)=>Promise<string>;
};

export const muxKits:MuxKit[]=[
  {kind:'tmux',label:'tmux',start:()=>SshFixture.start(undefined,{privateTtyGroup:true,tmux:true}),probe:tmuxProbe,clients:ssh=>tmuxClients(ssh),version:ssh=>ssh.tmux(['-V'])},
  {kind:'zellij',label:'Zellij',start:()=>SshFixture.start(undefined,{privateTtyGroup:true,zellijBinary:pinnedZellij()}),probe:zellijProbe,clients:zellijClients,version:ssh=>ssh.zellij(['--version'])},
];
