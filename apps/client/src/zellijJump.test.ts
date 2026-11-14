import {expect,it} from 'vitest';
import {zellijSnapshot,type ZellijTree} from './zellijJump';

const tab=(id:number,position:number,name:string,active=false)=>({id,position,name,active,panes:[{id:id*10,title:'sh',focused:true}]});

it('shows the tabs of the session as numbered windows with the active one current',()=>{
  const tree:ZellijTree={tabs:[tab(4,0,'shell'),tab(9,1,"logs '$(touch NO)'",true)]};
  expect(zellijSnapshot('work',tree)).toEqual({
    generation:'',
    current:{sessionId:'work',windowId:'9'},
    sessions:[{id:'work',name:'work',restoreName:'work',windows:[{id:'4',index:1,name:'shell'},{id:'9',index:2,name:"logs '$(touch NO)'"}]}],
  });
});

it('marks exactly one row even while Zellij flags the tab it left, and none when no client shows a tab',()=>{
  expect(zellijSnapshot('s',{tabs:[tab(1,0,'a',true),tab(2,1,'b',true)]}).current.windowId).toBe('1');
  const none=zellijSnapshot('s',{tabs:[tab(1,0,'a'),tab(2,1,'b')]});
  expect(none.current).toEqual({sessionId:'s',windowId:''});
  expect(none.sessions[0].windows.map(window=>window.id)).not.toContain('');
  expect(zellijSnapshot('empty',{tabs:[]}).sessions[0].windows).toEqual([]);
});
