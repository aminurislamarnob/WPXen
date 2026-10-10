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

function getLeaves(tree, x = 0, y = 0, w = 1, h = 1) {
  if (tree.leaf) {
    return [{ id: tree.leaf, x, y, w, h }];
  }
  const r = tree.ratio ? tree.ratio / 100 : 0.5;
  if (tree.dir === 'down') {
    return [
      ...getLeaves(tree.a, x, y, w, h * r),
      ...getLeaves(tree.b, x, y + h * r, w, h * (1 - r)),
    ];
  } else {
    return [
      ...getLeaves(tree.a, x, y, w * r, h),
      ...getLeaves(tree.b, x + w * r, y, w * (1 - r), h),
    ];
  }
}

export function neighbour(tree, sessionId, direction) {
  const leaves = getLeaves(tree);
  const current = leaves.find((l) => l.id === sessionId);
  if (!current) return null;

  const EPSILON = 0.0001;
  let candidates = [];

  for (const leaf of leaves) {
    if (leaf.id === sessionId) continue;

    if (direction === 'left') {
      if (Math.abs(leaf.x + leaf.w - current.x) < EPSILON) {
        if (
          leaf.y < current.y + current.h - EPSILON &&
          leaf.y + leaf.h > current.y + EPSILON
        ) {
          candidates.push(leaf);
        }
      }
    } else if (direction === 'right') {
      if (Math.abs(leaf.x - (current.x + current.w)) < EPSILON) {
        if (
          leaf.y < current.y + current.h - EPSILON &&
          leaf.y + leaf.h > current.y + EPSILON
        ) {
          candidates.push(leaf);
        }
      }
    } else if (direction === 'up') {
      if (Math.abs(leaf.y + leaf.h - current.y) < EPSILON) {
        if (
          leaf.x < current.x + current.w - EPSILON &&
          leaf.x + leaf.w > current.x + EPSILON
        ) {
          candidates.push(leaf);
        }
      }
    } else if (direction === 'down') {
      if (Math.abs(leaf.y - (current.y + current.h)) < EPSILON) {
        if (
          leaf.x < current.x + current.w - EPSILON &&
          leaf.x + leaf.w > current.x + EPSILON
        ) {
          candidates.push(leaf);
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  if (direction === 'left' || direction === 'right') {
    candidates.sort((a, b) => a.y - b.y);
  } else {
    candidates.sort((a, b) => a.x - b.x);
  }
  return candidates[0].id;
}
