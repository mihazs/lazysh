import {expect,test} from 'bun:test';
import {readdir,readlink,stat} from 'node:fs/promises';
import {ZellijFixture,zellijActiveTab,zellijActiveTabSettled,zellijClientCount,zellijTabHistoryVerified} from './support/androidZellij';
import {listening} from './support/androidSsh';

test('Zellij host readback admits only the two owned tabs and reports the single active one',()=>{
  const tab=(position:number,name:string,active:boolean)=>({position,name,active,tab_id:position});
  const read=(tabs:unknown[])=>zellijActiveTab(JSON.stringify(tabs));
  expect(read([tab(0,'alpha',false),tab(1,'beta',false)])).toBeNull();
  expect(read([tab(0,'alpha',true),tab(1,'beta',false)])).toBe(0);
  expect(read([tab(0,'alpha',false),tab(1,'beta',true)])).toBe(1);
  for(const invalid of [[],[tab(0,'alpha',true)],[tab(0,'alpha',true),tab(1,'gamma',false)],[tab(1,'beta',true),tab(0,'alpha',false)],
    [tab(0,'alpha',true),tab(1,'beta',true)],[tab(0,'alpha',true),tab(1,'beta',false),tab(2,'alpha',false)],[tab(0,'alpha',1 as unknown as boolean),tab(1,'beta',false)],[null,null]])
    expect(()=>read(invalid)).toThrow('Owned Zellij topology changed');
  for(const text of ['','not json','{"position":0}',JSON.stringify([tab(0,'alpha',true),tab(1,'beta',false)]).padEnd(16385,' ')])
    expect(()=>zellijActiveTab(text)).toThrow('Owned Zellij topology changed');
});

test('Zellij readback survives one unreadable answer but not a topology that stays wrong',async()=>{
  const owned=JSON.stringify([{position:0,name:'alpha',active:true},{position:1,name:'beta',active:false}]);
  const answers=(...texts:string[])=>{let reads=0;return {read:async()=>texts[Math.min(reads++,texts.length-1)],reads:()=>reads};};
  const transient=answers('',owned);
  expect(await zellijActiveTabSettled(transient.read)).toBe(0);
  expect(transient.reads()).toBe(2);
  const changed=answers('[]');
  await expect(zellijActiveTabSettled(changed.read,3)).rejects.toThrow('Owned Zellij topology changed');
  expect(changed.reads()).toBe(3);
});

test('Zellij readback retries a failing command and a command that keeps failing surfaces its own error',async()=>{
  const owned=JSON.stringify([{position:0,name:'alpha',active:true},{position:1,name:'beta',active:false}]);
  let reads=0;
  expect(await zellijActiveTabSettled(async()=>{if(++reads<3)throw new Error('Owned fixture failed: owned Zellij observation; exit=1');return owned;})).toBe(0);
  expect(reads).toBe(3);
  reads=0;
  await expect(zellijActiveTabSettled(async()=>{reads++;throw new Error('Owned fixture failed: owned Zellij observation; exit=1');},4)).rejects.toThrow('exit=1');
  expect(reads).toBe(4);
});

test('Zellij attach history requires attach, Tab 2, detach, reattach on that tab, Tab 1, Jump To tab 2 and the final detach in order',()=>{
  expect(zellijTabHistoryVerified([null,0,1,null,1,0,1,null])).toBe(true);
  for(const history of [[],[null,0,1,null],[null,0,1,null,1,0],[null,0,1,null,1,0,null],[null,0,null,0,null],[null,0,1,null,0,1,null],[0,1,null,1,0,1,null],[null,0,1,null,1,0,1,null,0]])
    expect(zellijTabHistoryVerified(history)).toBe(false);
});

test('Zellij client count is the rows under the header and refuses anything else',()=>{
  const header='CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n';
  expect(zellijClientCount(header)).toBe(0);
  expect(zellijClientCount(`${header}1 terminal_1 sleep 3600\n`)).toBe(1);
  expect(()=>zellijClientCount('')).toThrow('unreadable');
  expect(()=>zellijClientCount('No such session\n')).toThrow('unreadable');
});

// Real pinned tools are explicit; ordinary host checks never download or guess a binary.
test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_ZELLIJ)('owned Zellij session follows a real attach, tab switches and detaches and is gone with its fixture',async()=>{
  const owned=await ZellijFixture.start();
  const {directory,port}=owned.ssh;
  let client:Awaited<ReturnType<typeof owned.ssh.client>>|undefined;
  try {
    expect(owned.metadata().tabs.map(({position,name})=>[position,name])).toEqual([[0,'alpha'],[1,'beta']]);
    await expect(owned.verifyDetachedAndReattached()).rejects.toThrow('Owned Zellij attach, numbered tabs and detach were not observed');
    const wait=async(predicate:()=>boolean|Promise<boolean>)=>{
      const deadline=performance.now()+10_000;
      while(!await predicate()){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(25);}
    };
    const active=async(position:0|1|null)=>wait(async()=>{await owned.observe();return owned.diagnostic().history.at(-1)===position;});
    const attach=async(marker:string)=>{
      const shell=await owned.ssh.client();
      await wait(()=>shell.stdout.includes(owned.ssh.prompt));
      shell.child.stdin!.write(`exec zellij attach '${owned.name}'\n`);
      await wait(()=>shell.stdout.includes(marker));
      return shell;
    };
    const [alpha,beta]=owned.metadata().tabs;
    const goTo=(number:number)=>owned.ssh.zellij(['--session',owned.name,'action','go-to-tab',String(number)]);
    await active(null);
    expect(await owned.observeRestore()).toEqual({clients:0});
    client=await attach(alpha.marker);await active(0);
    expect(await owned.observeRestore()).toEqual({clients:1});
    expect(client.stdout.includes(beta.marker)).toBe(false);
    await goTo(2);await active(1);
    await wait(()=>client!.stdout.includes(beta.marker));
    await client.stop();await active(null);
    client=await attach(beta.marker);await active(1);
    await goTo(1);await active(0);
    // Jump To applies the tab id of the second tab.
    await goTo(2);await active(1);
    expect(await owned.paneHolds(beta.marker)).toBe(true);
    // The restore cases type into the focused pane of this tab and read its echo back from the host.
    await owned.ssh.zellij(['--session',owned.name,'action','write-chars','RESTORE_echo']);
    await wait(()=>owned.paneHolds('RESTORE_echo'));
    expect(await owned.paneHolds(alpha.marker)).toBe(false);
    await client.stop();
    // The final detach leaves the remembered session, both tabs and the single start of each pane.
    await owned.verifyDetachedAndReattached();
    expect(owned.diagnostic()).toEqual({schemaVersion:1,history:[null,0,1,null,1,0,1,null],tabs:2});
  } finally {
    await client?.stop();
    await owned.stop();
    await owned.stop();
  }
  expect(await listening(port)).toBe(false);
  await expect(stat(directory)).rejects.toMatchObject({code:'ENOENT'});
  // No process of the private Zellij copy outlives the fixture, whether it ran in sshd's namespace or not.
  const survivors=[];
  for(const entry of await readdir('/proc'))if(/^[1-9][0-9]*$/.test(entry) && (await readlink(`/proc/${entry}/exe`).catch(()=>'')).startsWith(`${directory}/bin/zellij`))survivors.push(entry);
  expect(survivors).toEqual([]);
},90_000);
