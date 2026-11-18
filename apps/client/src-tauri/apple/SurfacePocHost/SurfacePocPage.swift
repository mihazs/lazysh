/// The fixture page of the composition proof of concept. Like the app's page it is transparent over the
/// pane, declares `viewport-fit=cover`, sizes the pane from the visual viewport (which is what iOS shrinks
/// for the keyboard, as `TerminalPane` reads it) and reports the pane's rectangle to native code.
///
/// The pane is `#anchor`; `#overlap` is an opaque DOM box over its lower right corner, standing in for a
/// menu or toolbar that must stay above the surface. Nothing paints inside `#anchor`.
let surfacePocPage = #"""
<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<style>
  html, body { margin: 0; background: transparent; }
  body { min-height: calc(100vh + 80px); font: 15px -apple-system, sans-serif; }
  #anchor { position: absolute; width: 200px; height: 200px;
    left: calc(env(safe-area-inset-left) + 40px); top: calc(env(safe-area-inset-top) + 48px); }
  #overlap { position: absolute; width: 100px; height: 80px; background: #e02020; }
  #field { position: fixed; box-sizing: border-box; width: 200px; height: 32px; border: 0; border-radius: 6px;
    padding: 0 8px; font-size: 16px; background: #fff;
    left: calc(env(safe-area-inset-left) + 40px); top: calc(env(safe-area-inset-top) + 4px); }
  .command { position: fixed; width: 150px; height: 44px; bottom: calc(env(safe-area-inset-bottom) + 8px); }
  #remove { left: calc(env(safe-area-inset-left) + 16px); }
  #recreate { left: calc(env(safe-area-inset-left) + 182px); }
</style>
<div id="anchor" role="img" aria-label="Surface anchor"></div>
<div id="overlap" role="img" aria-label="Overlap box"></div>
<div id="inset" style="position: fixed; visibility: hidden; padding: env(safe-area-inset-top) 0 0 env(safe-area-inset-left)"></div>
<input id="field" aria-label="Surface field" autocapitalize="off" autocorrect="off" spellcheck="false">
<button id="remove" class="command">Remove surface</button>
<button id="recreate" class="command">Recreate surface</button>
<script>
  const post = message => webkit.messageHandlers.poc.postMessage(message);
  const anchor = document.getElementById('anchor'), overlap = document.getElementById('overlap');
  let frame = 0;
  function update() {
    const viewport = window.visualViewport;
    anchor.style.height = Math.max(60, Math.round(viewport.height - anchor.offsetTop - 130)) + 'px';
    overlap.style.left = anchor.offsetLeft + anchor.offsetWidth - 60 + 'px';
    overlap.style.top = anchor.offsetTop + anchor.offsetHeight - 40 + 'px';
    const box = anchor.getBoundingClientRect(), inset = getComputedStyle(document.getElementById('inset'));
    post({type: 'anchor', x: box.left - viewport.offsetLeft, y: box.top - viewport.offsetTop,
      width: box.width, height: box.height, viewportWidth: window.innerWidth, viewportHeight: viewport.height,
      scrollY: window.scrollY, safeTop: parseFloat(inset.paddingTop), safeLeft: parseFloat(inset.paddingLeft)});
  }
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
  for (const target of [window, window.visualViewport]) for (const name of ['resize', 'scroll']) target.addEventListener(name, schedule);
  window.addEventListener('load', schedule);
  // env(safe-area-inset-*) arrives after the first layout and fires no resize or scroll: watch a probe whose size is the inset.
  new ResizeObserver(schedule).observe(document.getElementById('inset'), {box: 'border-box'});
  const field = document.getElementById('field');
  field.addEventListener('keydown', event => { if (event.key === 'Enter') field.blur(); });
  anchor.addEventListener('pointerdown', () => post({type: 'tap'}));
  for (const type of ['remove', 'recreate']) document.getElementById(type).addEventListener('click', () => post({type}));
</script>
"""#
