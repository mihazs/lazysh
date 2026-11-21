import type {TmuxJumpSnapshot} from '../bridge';

export const tmuxJumpSnapshot: TmuxJumpSnapshot = {
  generation:'actor-one', current:{sessionId:'$1',windowId:'@3'}, sessions:[
    {id:'$1',name:'work',restoreName:'work',windows:[{id:'@3',index:0,name:'agent'}]},
    {id:'$2',name:'other',restoreName:'other',windows:[{id:'@4',index:1,name:'build'}]},
  ],
};

/** A binding that lists panes: `work` has a window with two panes (the displayed one runs an agent) and a zoomed window; `other` has one pane. */
export const tmuxJumpPaneSnapshot: TmuxJumpSnapshot = {
  generation:'actor-one', current:{sessionId:'$1',windowId:'@3',paneId:'%7'}, sessions:[
    {id:'$1',name:'work',restoreName:'work',windows:[
      {id:'@3',index:0,name:'agent',zoomed:false,panes:[
        {id:'%6',index:0,title:'',command:'vim',active:false},
        {id:'%7',index:1,title:'review',command:'node',active:true},
      ]},
      {id:'@5',index:1,name:'build',zoomed:true,panes:[
        {id:'%8',index:0,title:'',command:'cargo',active:true},
        {id:'%9',index:1,title:'',command:'tail',active:false},
      ]},
    ]},
    {id:'$2',name:'other',restoreName:'other',windows:[{id:'@4',index:0,name:'logs',zoomed:false,panes:[{id:'%10',index:0,title:'',command:'htop',active:true}]}]},
  ],
};
