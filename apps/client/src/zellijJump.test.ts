import {expect,it} from 'vitest';
import {zellijSnapshot,type ZellijJumpTabs} from './zellijJump';

const tab=(id:number|undefined,position:number,name:string,active=false)=>({...(id===undefined?{}:{id}),position,name,active});

it('shows the tabs of the session as numbered windows with the active one current while this terminal is the only client',()=>{
  const tabs:ZellijJumpTabs={clients:1,tabs:[tab(4,0,'shell'),tab(9,1,"logs '$(touch NO)'",true)]};
  expect(zellijSnapshot('work',tabs)).toEqual({
    generation:'',
    current:{sessionId:'work',windowId:'9'},
    sessions:[{id:'work',name:'work',restoreName:'work',windows:[{id:'4',index:1,name:'shell'},{id:'9',index:2,name:"logs '$(touch NO)'"}]}],
  });
});

it('claims no current tab and marks the session shared when another client is attached, or none is',()=>{
  // Two clients on different tabs both show an active tab: neither is this terminal's.
  const two=zellijSnapshot('s',{clients:2,tabs:[tab(1,0,'a',true),tab(2,1,'b',true)]});
  expect(two.current).toEqual({sessionId:'s',windowId:''});
  expect(two.sharedClients).toBe(true);
  expect(two.sessions[0].windows.map(window=>window.id)).toEqual(['1','2']);
  expect(zellijSnapshot('s',{clients:0,tabs:[tab(1,0,'a')]}).sharedClients).toBe(true);
  expect(zellijSnapshot('empty',{clients:1,tabs:[]}).sessions[0].windows).toEqual([]);
});

it('leaves out a tab that has no stable id, because a jump could not name it',()=>{
  expect(zellijSnapshot('s',{clients:1,tabs:[tab(undefined,0,'old',true),tab(3,1,'new')]}).sessions[0].windows).toEqual([{id:'3',index:2,name:'new'}]);
});
