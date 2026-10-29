// Passive, case-owned evidence only: never retain event objects or target content.
function ownedNativeTapObservation(target) {
  const n = value => Number.isFinite(value) && Math.abs(value) <= 65535 ? value : null;
  const rect = target.getBoundingClientRect(), visual = window.visualViewport;
  const before = {
    enabled: target.disabled === false,
    connected: target.isConnected === true,
    focused: window.document?.activeElement === target,
    rect: [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].map(n),
    viewport: [window.innerWidth, window.innerHeight, window.devicePixelRatio].map(n),
    visualViewport: [visual?.width, visual?.height, visual?.offsetLeft, visual?.offsetTop, visual?.scale].map(n)
  };
  const types = ['pointerdown', 'pointerup', 'click'];
  const records = types.map(() => ({count: 0, overflow: false, trusted: null, target: null, point: null}));
  let closed = false;
  const listeners = types.map((type, index) => [type, event => {
    const record = records[index];
    if (record.count > 0) record.overflow = true;
    record.count = Math.min(2, record.count + 1);
    if (record.count === 1) {
      record.trusted = event.isTrusted === true;
      record.target = event.target === target;
      record.point = [n(event.clientX), n(event.clientY)];
    }
  }]);
  const close = () => {
    if (closed) return true;
    let failed = false;
    for (const [type, listener] of listeners) {
      try { window.removeEventListener(type, listener, true); } catch (_) { failed = true; }
    }
    if (failed) throw new Error('Owned native tap cleanup unavailable');
    closed = true;
    return true;
  };
  try {
    for (const [type, listener] of listeners) window.addEventListener(type, listener, {capture: true, passive: true});
  } catch (_) {
    try { close(); } catch (_) { /* Original setup failure remains closed. */ }
    throw new Error('Owned native tap observation unavailable');
  }
  return {
    read: () => ({before, down: {...records[0]}, up: {...records[1]}, click: {...records[2]}, closed}),
    close
  };
}
