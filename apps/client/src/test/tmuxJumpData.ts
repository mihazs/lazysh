import type {TmuxJumpSnapshot} from '../bridge';

export const tmuxJumpSnapshot: TmuxJumpSnapshot = {
  generation:'actor-one', current:{sessionId:'$1',windowId:'@3'}, sessions:[
    {id:'$1',name:'work',restoreName:'work',windows:[{id:'@3',index:0,name:'agent'}]},
    {id:'$2',name:'other',restoreName:'other',windows:[{id:'@4',index:1,name:'build'}]},
  ],
};
