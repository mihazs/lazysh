/** Keyboard focus helpers shared by dialogs and drawers. */
export function focusableWithin(container:HTMLElement|null) {
  return Array.from(
        container?.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, summary, a[href], [tabindex]',
        ) ?? [],
      ).filter(control => {
        if (control.tabIndex < 0 || control.matches(':disabled')
          || control.closest('[hidden], [inert]')
          || control.getClientRects().length === 0
          || getComputedStyle(control).visibility !== 'visible') return false;
        // Collapsed details may retain cached layout rects after being opened.
        for (let parent=control.parentElement; parent && parent!==container; parent=parent.parentElement) {
          if (parent.matches('details:not([open])')
            && !parent.querySelector(':scope > summary')?.contains(control)) return false;
        }
        return true;
      })
        .sort((a,b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}
export function cycleFocus(event:KeyboardEvent,items:HTMLElement[]) {
  if(event.key!=='Tab')return;
  const first=items[0],last=items.at(-1);
  if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
}
