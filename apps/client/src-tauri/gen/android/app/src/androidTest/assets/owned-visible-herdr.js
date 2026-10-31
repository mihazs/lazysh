// Read-only evidence: inactive canvases cannot satisfy a selected-display proof.
function ownedVisibleHerdr(document, labels, selected, marker, forbidden) {
  const tabs=Array.from(document.querySelectorAll('.session-tabs [role=tab]'));
  const visible=node=>node.getClientRects().length>0&&node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0&&getComputedStyle(node).display!=='none'&&getComputedStyle(node).visibility!=='hidden';
  const panes=Array.from(document.querySelectorAll('.terminal-pane')).filter(visible);
  const screens=panes.length===1?Array.from(panes[0].querySelectorAll('.xterm-screen')).filter(visible):[];
  return tabs.length===labels.length&&tabs.every((tab,index)=>tab.textContent.trim()===labels[index]&&!tab.querySelector('.status-idle')&&tab.getAttribute('aria-selected')===(index===selected?'true':'false'))
    &&panes.length===1&&screens.length===1&&screens[0].textContent.includes(marker)&&forbidden.every(text=>!screens[0].textContent.includes(text));
}
