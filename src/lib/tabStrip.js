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
    if (session && !session.exited) {
      running++;
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
