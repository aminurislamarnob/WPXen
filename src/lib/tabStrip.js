export function tabsToClose(order, key, action) {
  const index = order.indexOf(key);
  if (index === -1) return [];

  switch (action) {
    case 'close':
      return [key];
    case 'others':
      return order.filter((k) => k !== key);
    case 'left':
      return order.slice(0, index);
    case 'right':
      return order.slice(index + 1);
    default:
      return [];
  }
}

export function closeImpact(keys, sessionsById, dirtyKeys) {
  let running = 0;
  let dirty = [];

  for (const key of keys) {
    if (dirtyKeys.includes(key)) {
      dirty.push(key);
    }
    const session = sessionsById[key];
    if (session) {
      if (!session.exited) running++;
      if (session.layout) {
        const traverse = (node) => {
          if (node.leaf && node.leaf !== key) {
            const sub = sessionsById[node.leaf];
            if (sub && !sub.exited) running++;
          } else if (node.dir) {
            traverse(node.a);
            traverse(node.b);
          }
        };
        traverse(session.layout);
      }
    }
  }

  return { running, dirty };
}

export function nextActive(order, closedKeys, activeKey) {
  const remaining = order.filter((k) => !closedKeys.includes(k));
  if (remaining.length === 0) return null;
  if (!closedKeys.includes(activeKey)) return activeKey;

  const activeIndex = order.indexOf(activeKey);
  if (activeIndex === -1) return remaining[remaining.length - 1];

  for (let i = activeIndex + 1; i < order.length; i++) {
    if (!closedKeys.includes(order[i])) return order[i];
  }
  for (let i = activeIndex - 1; i >= 0; i--) {
    if (!closedKeys.includes(order[i])) return order[i];
  }

  return remaining[0];
}

// "Don't ask again" covers ending running Sessions only. Unsaved file edits
// always ask, the same as closing one dirty file from its X.
export function needsBulkConfirm(impact, suppressed) {
  if (impact.dirty.length > 0) return true;
  return impact.running > 0 && !suppressed;
}

// Every Session a tab holds: its panes, or just itself when it isn't split.
export function paneIds(layout, rootId) {
  if (!layout) return [rootId];
  if (layout.leaf) return [layout.leaf];
  return [...paneIds(layout.a), ...paneIds(layout.b)];
}
