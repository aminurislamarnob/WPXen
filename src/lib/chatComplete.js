export function matchFiles(query, files, limit = 50) {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();

  const matches = [];
  for (const file of files) {
    const lower = file.toLowerCase();

    // subsequence match
    let qIdx = 0;
    for (let i = 0; i < lower.length && qIdx < q.length; i++) {
      if (lower[i] === q[qIdx]) qIdx++;
    }
    if (qIdx === q.length) {
      matches.push(file);
    }
  }

  // rank basename hits first
  matches.sort((a, b) => {
    const aBase = a.split('/').pop().toLowerCase();
    const bBase = b.split('/').pop().toLowerCase();
    const aBaseHit = aBase.includes(q);
    const bBaseHit = bBase.includes(q);
    if (aBaseHit && !bBaseHit) return -1;
    if (!aBaseHit && bBaseHit) return 1;

    // If both or neither match in basename, rank exact prefix hits first
    const aPrefix = aBase.startsWith(q);
    const bPrefix = bBase.startsWith(q);
    if (aPrefix && !bPrefix) return -1;
    if (!aPrefix && bPrefix) return 1;

    return a.length - b.length || a.localeCompare(b);
  });

  return matches.slice(0, limit);
}

export function matchCommands(query, commands, limit = 50) {
  if (!query) return commands.slice(0, limit);
  const q = query.toLowerCase();

  const matches = [];
  for (const cmd of commands) {
    const lower = cmd.name.toLowerCase();

    // subsequence match
    let qIdx = 0;
    for (let i = 0; i < lower.length && qIdx < q.length; i++) {
      if (lower[i] === q[qIdx]) qIdx++;
    }
    if (qIdx === q.length) {
      matches.push(cmd);
    }
  }

  // Rank exact prefix hits first
  matches.sort((a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(q);
    const bPrefix = b.name.toLowerCase().startsWith(q);
    if (aPrefix && !bPrefix) return -1;
    if (!aPrefix && bPrefix) return 1;
    return a.name.length - b.name.length || a.name.localeCompare(b.name);
  });

  return matches.slice(0, limit);
}

export function recallStep(history, index, dir) {
  if (!history || history.length === 0) return { index: -1, text: null };
  const nextIndex = index + dir;
  if (nextIndex < 0) return { index: -1, text: null };
  if (nextIndex >= history.length)
    return { index: history.length - 1, text: history[history.length - 1] };
  return { index: nextIndex, text: history[nextIndex] };
}

// What the caret is completing, or null. `@` mentions a Site file anywhere
// after whitespace; `/` names a command only at the start of the prompt,
// where Claude reads one — a path typed mid-sentence is not a command.
export function completionTrigger(text, caret) {
  const before = String(text || '').slice(0, caret);
  const command = /^\/(\S*)$/.exec(before);
  if (command) return { type: 'cmd', query: command[1], start: 1 };
  const mention = /(?:^|\s)@(\S*)$/.exec(before);
  if (mention)
    return { type: 'file', query: mention[1], start: caret - mention[1].length };
  return null;
}

// The prompt with a chosen completion in place of what was typed. Commands
// carry their own leading slash, so the typed one is replaced, not doubled.
export function applyCompletion(text, trigger, value) {
  const head = trigger.type === 'cmd' ? '' : text.slice(0, trigger.start);
  const tail = text.slice(trigger.start + trigger.query.length);
  return `${head}${value} ${tail.replace(/^ /, '')}`;
}

// Whether ↑/↓ steps prompt recall instead of moving the caret: ↑ from an
// empty composer (or while already recalling) on the first line, ↓ only
// while recalling and on the last line — so multi-line editing still works.
export function recallKey({ key, text, caret, recalling }) {
  const value = String(text || '');
  if (key === 'ArrowUp') {
    if (!recalling && value !== '') return false;
    return !value.slice(0, caret).includes('\n');
  }
  if (key === 'ArrowDown') {
    return recalling && !value.slice(caret).includes('\n');
  }
  return false;
}
