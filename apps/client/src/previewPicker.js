// Runs only inside the separate, unprivileged preview frame. Page data is untrusted.
(() => {
  'use strict';
  const token = document.currentScript?.dataset.lazyshPicker;
  if (!token || window.parent === window) return;
  let channel = '';
  let enabled = false;
  let overlay;
  const blockedKeys = new Set();
  const clean = (value, limit) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  const send = (action, extra = {}) => window.parent.postMessage({ type: 'lazysh-picker', token, channel, action, ...extra }, '*');
  const hide = () => { overlay?.remove(); overlay = undefined; };
  const eligible = element => element instanceof Element && !element.closest('input,textarea,select,option,script,style,noscript,[contenteditable]') && element !== document.documentElement && element !== document.body;
  const visiblyRendered = element => {
    if (!element.getClientRects().length) return false;
    let count = 0;
    for (let current = element; current; current = current.parentElement) {
      if (++count > 32) return false;
      const style = getComputedStyle(current);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const visibleText = element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = ''; let count = 0;
    while (count++ < 128 && text.length < 300) {
      const node = walker.nextNode();
      if (!node) break;
      const parent = node.parentElement;
      if (parent && !parent.closest('input,textarea,select,option,script,style,noscript,[contenteditable],[hidden],[aria-hidden="true"]') && visiblyRendered(parent)) text += ` ${node.textContent.slice(0, 300 - text.length)}`;
    }
    return clean(text, 300);
  };
  const selector = element => {
    const parts = [];
    for (let current = element; current && parts.length < 6; current = current.parentElement) {
      const tag = current.localName;
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) break;
      let index = 1; let steps = 0;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (++steps > 4096) return '';
        if (sibling.localName === tag) index++;
      }
      parts.unshift(`${tag}:nth-of-type(${index})`);
    }
    return parts.join(' > ').slice(0, 512);
  };
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window.parent || !data || data.type !== 'lazysh-picker' || data.token !== token || typeof data.channel !== 'string' || !/^[a-f0-9-]{36}$/.test(data.channel)) return;
    if (data.action === 'init') { channel = data.channel; enabled = false; hide(); send('ready'); }
    else if (data.channel === channel && data.action === 'start') { enabled = true; send('started'); }
    else if (data.channel === channel && data.action === 'stop') { enabled = false; hide(); }
  });
  window.addEventListener('pointermove', event => {
    if (!enabled) return;
    hide();
    if (!eligible(event.target)) return;
    const rect = event.target.getBoundingClientRect();
    overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', outline: '3px solid #1680ec', background: 'rgba(22,128,236,.12)', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    document.documentElement.append(overlay);
  }, true);
  // Stop target/page activation handlers before a picking gesture reaches them.
  // Touch defaults stay enabled so browsers still synthesize the intercepted click.
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchcancel']) {
    window.addEventListener(type, event => {
      if (!enabled) return;
      event.stopImmediatePropagation();
      if (!type.startsWith('touch')) event.preventDefault();
    }, { capture: true, passive: false });
  }
  const select = element => {
    if (!eligible(element)) return;
    const rect = element.getBoundingClientRect();
    enabled = false; hide();
    send('selection', { path: clean(location.pathname, 4096), selector: selector(element), text: visibleText(element), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  };
  window.addEventListener('click', event => {
    if (!enabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    select(event.target);
  }, true);
  window.addEventListener('keydown', event => {
    if (!enabled) return;
    event.stopImmediatePropagation();
    // Allow focus traversal, while preventing host shortcuts, typing and activation.
    if (event.key === 'Tab') return;
    event.preventDefault(); blockedKeys.add(event.code || event.key);
    if (event.key === 'Escape') { enabled = false; hide(); send('cancel'); }
  }, true);
  window.addEventListener('keypress', event => {
    if (enabled || blockedKeys.has(event.code || event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('keyup', event => {
    const blocked = blockedKeys.delete(event.code || event.key);
    if (enabled || blocked) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
})();
