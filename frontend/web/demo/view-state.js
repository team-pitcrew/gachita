// File choosers and hidden controls do not contain editable text to preserve.
export function editingText(element, container) {
  if (!element || !container?.contains(element) || element.hidden || element.disabled || element.readOnly) return false;
  return element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' && ['text', 'number', 'search', 'email', 'tel', 'url', 'password'].includes(element.type);
}

// A completed local action must get a fresh read even when an older poll is still in flight.
export function serialRefresh(read) {
  let active, queued = false;
  return function refresh(force = false) {
    if (active) { queued ||= force; return active; }
    active = Promise.resolve().then(async () => {
      let required = force || queued;
      do { queued = false; await read(required); required = queued; } while (required);
    }).finally(() => {
      active = null;
      if (queued) { queued = false; return refresh(true); }
    });
    return active;
  };
}
