// Read-only evidence: inactive canvases cannot satisfy a selected-display proof.
function ownedVisibleHerdr(document, labels, selected, marker, forbidden) {
  const tabs=Array.from(document.querySelectorAll('.session-tabs [role=tab]'));
  const visible=node=>node.getClientRects().length>0&&node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0&&getComputedStyle(node).display!=='none'&&getComputedStyle(node).visibility!=='hidden';
  const panes=Array.from(document.querySelectorAll('.terminal-pane')).filter(visible);
  const screens=panes.length===1?Array.from(panes[0].querySelectorAll('.xterm-screen')).filter(visible):[];
  return tabs.length===labels.length&&tabs.every((tab,index)=>tab.textContent.trim()===labels[index]&&!tab.querySelector('.status-idle')&&tab.getAttribute('aria-selected')===(index===selected?'true':'false'))
    &&panes.length===1&&screens.length===1&&screens[0].textContent.includes(marker)&&forbidden.every(text=>!screens[0].textContent.includes(text));
}

// Shipping Agents navigation is separate from the companion report board.
function ownedLiveHerdrNavigation(document, server, context) {
  const panels=Array.from(document.querySelectorAll('.herdr-navigation:not([hidden])'));
  if(panels.length!==1 || panels[0].getClientRects().length===0)return false;
  const panel=panels[0],rows=panel.querySelectorAll('.herdr-navigation-row');
  return panel.querySelector('select')?.value===server && panel.querySelector('h3')?.textContent==='Live Herdr agents'
    && Array.from(panel.querySelectorAll('p')).some(node=>node.textContent==='Shared focus changes focus for other connections to this server.')
    && rows.length===1 && rows[0].querySelector('strong')?.textContent==='codex'
    && rows[0].querySelector(':scope > small')?.textContent==='Unknown status'
    && rows[0].querySelector('span > small')?.textContent===context && !rows[0].querySelector('input,textarea');
}
