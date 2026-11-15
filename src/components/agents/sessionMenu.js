import {
  ArrowRightLeft,
  Bell,
  BellOff,
  Copy,
  FolderOpen,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  SquareTerminal,
  Code2,
  Trash2,
  X,
} from 'lucide-react';
import { TAB_COLORS } from '../../lib/tabColors';

// The Agents sidebar's right-click menu for one Session, after Orca's
// worktree row menu: state toggles first (Mark Unread, Pin), naming and the
// Session's own actions next, places and clipboard in submenus, the
// destructive item last in red behind a second click.
//
// Orca's worktree-only entries have no Session counterpart and are left out:
// Sleep, Move to Status, Parent & Children, Project Group, Delete Worktree.
// Remove Project stays on the project row's own menu.
//
// `s` is a sidebar row (displayTitle, cwd, transcriptId…); `act` holds the
// callbacks, so this stays free of IPC and navigation.
export function sessionMenuItems(s, act) {
  const ended = s.state === 'exited' || s.state === 'error';
  const items = [
    {
      label: s.unread ? 'Mark Read' : 'Mark Unread',
      icon: s.unread ? BellOff : Bell,
      onClick: act.toggleUnread,
    },
    {
      label: s.pinned ? 'Unpin' : 'Pin',
      icon: s.pinned ? PinOff : Pin,
      onClick: act.togglePin,
    },
    'separator',
    { label: 'Rename…', icon: Pencil, onClick: act.rename },
  ];

  if (s.isAgent && !ended) {
    items.push({
      label: 'Hand Off to Another Agent…',
      icon: ArrowRightLeft,
      onClick: act.handoff,
    });
  }
  if (s.chat) {
    items.push({
      label: act.isChatView ? 'Switch to Terminal View' : 'Switch to Chat View',
      icon: act.isChatView ? SquareTerminal : MessageSquare,
      onClick: act.toggleView,
    });
  }

  items.push('separator');
  if (s.cwd) {
    items.push({
      label: 'Open in',
      icon: FolderOpen,
      items: [
        { label: 'Finder', icon: FolderOpen, onClick: act.openInFinder },
        { label: 'Editor', icon: Code2, onClick: act.openInEditor },
        { label: 'Terminal', icon: SquareTerminal, onClick: act.openInTerminal },
      ],
    });
  }
  const copies = [{ label: 'Name', onClick: () => act.copy(s.displayTitle) }];
  if (s.cwd) copies.push({ label: 'Path', onClick: () => act.copy(s.cwd) });
  if (s.transcriptId) {
    copies.push({ label: 'Session ID', onClick: () => act.copy(s.transcriptId) });
    if (s.agentId === 'claude') {
      copies.push({
        label: 'Resume Command',
        onClick: () => act.copy(`claude --resume ${s.transcriptId}`),
      });
    }
  }
  items.push({ label: 'Copy', icon: Copy, items: copies });
  items.push({
    label: 'Tab Color',
    swatches: TAB_COLORS,
    value: s.color ?? null,
    onPick: act.setColor,
  });

  items.push('separator');
  items.push(
    ended
      ? { label: 'Dismiss', icon: X, onClick: act.dismiss }
      : {
          label: 'End Session',
          icon: Trash2,
          danger: true,
          confirm: 'Click again to end it',
          hint: s.isAgent ? 'Stops the agent and closes its tab.' : 'Closes the shell.',
          onClick: act.end,
        }
  );
  return items;
}
