/** Synthetic remote identities, deliberately containing interpolation/markup syntax. */
export const remoteMuxName = "agent {{name}} <b>世界</b>";
export const remoteMuxDirectory = "/work/literal {{path}} 'quoted'";
export const remoteMuxError = 'RAW_HOST_ERROR {{key}} <b>leave unchanged</b>';
export const muxFixture = {
  tmuxAvailable: true, herdrAvailable: true, zellijAvailable: true,
  sessions: [{id:'$41',name:remoteMuxName,windows:[{id:'@52',index:2,name:'literal window',active:true,
    panes:[{id:'%63',index:0,active:true,command:'remote-command',path:remoteMuxDirectory}]}]}],
};
export const herdrFixture = {
  workspaces:[{workspace_id:'w7',label:remoteMuxName,focused:true,agent_status:'working'}],
  tabs:[{tab_id:'w7:t8',workspace_id:'w7',label:'literal tab',number:3,focused:true,agent_status:'blocked'}],
  panes:[{pane_id:'w7:p9',workspace_id:'w7',tab_id:'w7:t8',cwd:remoteMuxDirectory,focused:true,agent_status:'unknown'}],
};
export const muxLocales = [
  {locale:'en',region:'Multiplexer workspaces',server:'tmux server',browse:'Browse server',rename:'Rename session',name:'Name',save:'Save workspace',attach:'Attach',herdrRegion:`Herdr ${remoteMuxName} workspaces`,newHerdr:'New Herdr workspace',herdrLabel:'Workspace or tab label',herdrSave:'Save Herdr workspace',zellijRegion:`Zellij ${remoteMuxName} controls`,tab:'New tab name',directory:'Zellij project directory',create:'Create Zellij tab',sent:'Action sent to Zellij.',refresh:'Refresh'},
  {locale:'pt-BR',region:'Áreas de trabalho dos multiplexadores',server:'Servidor tmux',browse:'Explorar servidor',rename:'Renomear sessão',name:'Nome',save:'Salvar área de trabalho',attach:'Anexar',herdrRegion:`Áreas de trabalho Herdr ${remoteMuxName}`,newHerdr:'Nova área de trabalho Herdr',herdrLabel:'Rótulo da área de trabalho ou aba',herdrSave:'Salvar área de trabalho Herdr',zellijRegion:`Controles Zellij ${remoteMuxName}`,tab:'Nome da nova aba',directory:'Diretório do projeto Zellij',create:'Criar aba Zellij',sent:'Ação enviada ao Zellij.',refresh:'Atualizar'},
  {locale:'es',region:'Espacios de trabajo de los multiplexores',server:'Servidor tmux',browse:'Explorar servidor',rename:'Renombrar sesión',name:'Nombre',save:'Guardar espacio de trabajo',attach:'Adjuntar',herdrRegion:`Espacios de trabajo Herdr ${remoteMuxName}`,newHerdr:'Nuevo espacio de trabajo Herdr',herdrLabel:'Etiqueta del espacio de trabajo o pestaña',herdrSave:'Guardar espacio de trabajo Herdr',zellijRegion:`Controles Zellij ${remoteMuxName}`,tab:'Nombre de la nueva pestaña',directory:'Directorio del proyecto Zellij',create:'Crear pestaña Zellij',sent:'Acción enviada a Zellij.',refresh:'Actualizar'},
] as const;
