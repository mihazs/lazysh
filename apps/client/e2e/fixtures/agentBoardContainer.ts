export function agentBoardContainer() {
  const container=document.createElement('div');container.className='agent-board-fixture';
  Object.assign(container.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--theme-bg)',padding:'12px'});
  document.body.append(container);
  return container;
}
