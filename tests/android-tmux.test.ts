import {expect,test} from 'bun:test';
import {stat} from 'node:fs/promises';
import {TmuxFixture,tmuxAttachHistoryVerified,tmuxDisplayClients,tmuxPaneRows} from './support/androidTmux';
import {listening,type OwnedProcess} from './support/androidSsh';

test('tmux host readback admits only the owned two-window topology and display clients',()=>{
  const row=(index:number,name:string,active:number,dead=0)=>`@${index+1}|${index}|${name}|${active}|%${index}|${100+index}|${dead}`;
  expect(tmuxPaneRows(`${row(0,'alpha',1)}\n${row(1,'beta',0,1)}\n`)).toEqual([
    {windowId:'@1',index:0,name:'alpha',active:true,paneId:'%0',pid:100,dead:false},
    {windowId:'@2',index:1,name:'beta',active:false,paneId:'%1',pid:101,dead:true},
  ]);
  for(const invalid of ['',row(0,'alpha',1),`${row(0,'alpha',1)}\n${row(1,'gamma',0)}`,`${row(0,'alpha',1)}\n${row(1,'beta',0)}\n${row(2,'beta',0)}`,
    `${row(0,'alpha',1)}\n${row(1,'beta',0)}|private`,`${row(0,'alpha',1)}\n${row(1,'beta',0).replace('|101|','|0|')}`])
    expect(()=>tmuxPaneRows(invalid)).toThrow('Owned tmux topology changed');
  expect(tmuxDisplayClients('')).toBe(0);
  expect(tmuxDisplayClients('1\n0\n1\n')).toBe(1);
  for(const invalid of ['2\n','0\n'.repeat(9),'private\n'])expect(()=>tmuxDisplayClients(invalid)).toThrow('Owned tmux client readback invalid');
  expect(tmuxAttachHistoryVerified([0,1,0,1,0])).toBe(true);
  for(const history of [[0,1,0],[0,1,0,1],[0,1,2,1,0],[1,0,1,0],[0,1,0,1,0,1,0]])expect(tmuxAttachHistoryVerified(history)).toBe(false);
});

// Real pinned tools are explicit; ordinary host checks never download or guess a binary.
test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned namespaced tmux survives a real SSH detach and reattaches the original panes',async()=>{
  const owned=await TmuxFixture.start();
  const [alpha,beta]=owned.metadata().windows;
  let client:OwnedProcess|undefined;
  try {
    expect(owned.metadata().windows.map(({index,name})=>[index,name])).toEqual([[0,'alpha'],[1,'beta']]);
    await expect(owned.verifyDetachedAndReattached()).rejects.toThrow('Owned tmux attach, detach and reattach were not observed');
    const wait=async(predicate:()=>boolean|Promise<boolean>)=>{
      const deadline=performance.now()+5000;
      while(!await predicate()){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(25);}
    };
    const clients=async(count:number)=>wait(async()=>{await owned.observe();return owned.diagnostic().history.at(-1)===count;});
    const attach=async(marker:string)=>{
      const shell=await owned.ssh.client();
      await wait(()=>shell.stdout.includes(owned.ssh.prompt));
      shell.child.stdin!.write("exec tmux -u -L default attach-session -t '=owned-tmux'\n");
      await wait(()=>shell.stdout.includes(marker));
      return shell;
    };
    client=await attach(alpha.marker);await clients(1);
    client.child.stdin!.write('\x02d');
    await client.finish('owned tmux prefix detach',5000);
    await clients(0);
    client=await attach(alpha.marker);await clients(1);
    // The status line names windows only; beta's pane marker appears after the numbered switch.
    expect(client.stdout.includes(beta.marker)).toBe(false);
    client.child.stdin!.write('\x021');
    await wait(()=>client!.stdout.includes(beta.marker));
    await client.stop();
    await owned.verifyDetachedAndReattached();
    expect(owned.diagnostic()).toEqual({schemaVersion:1,history:[0,1,0,1,0],windows:2});
  } finally {
    await client?.stop();
    await owned.stop();
  }
  await expect(owned.observe()).rejects.toThrow('Owned tmux server identity changed');
  expect(await listening(owned.ssh.port)).toBe(false);
  await expect(stat(owned.ssh.directory)).rejects.toMatchObject({code:'ENOENT'});
},30_000);
