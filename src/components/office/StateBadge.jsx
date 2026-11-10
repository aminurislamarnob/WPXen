import { Circle } from 'lucide-react';
import { stateBadge } from '../../lib/office/hud.js';

// An Agent State as WPXen chrome: a dot + label on the status tokens, with
// the running tool beside it while working. Waiting on you is the state that
// blocks on the user, so it alone is a filled pill. The tone → token mapping
// lives in lib/office/hud.js (stateBadge).

const TONE_CLASS = {
  warning: 'text-status-warning',
  error: 'text-status-error',
  running: 'text-status-running',
  highlight: 'text-highlight',
  muted: 'text-muted-foreground',
};

/**
 * @param {object} props
 * @param {{ label: string, tone: string, tool?: string }} [props.badge] A
 *   precomputed stateBadge(); otherwise derived from state/tool/onBreak.
 */
export function StateBadge({ badge, state, tool, onBreak, compact = false }) {
  const { label, tone, tool: shownTool } = badge ?? stateBadge(state, { tool, onBreak });
  const size = compact ? 'text-[11px]' : 'text-xs';
  const toolChip = shownTool && (
    <code className="font-mono text-[10.5px] font-normal text-muted-foreground bg-muted rounded-sm px-1.5 py-px truncate max-w-[9rem]">
      {shownTool}
    </code>
  );
  if (tone === 'warning') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 border border-status-warning/30 bg-status-warning/10 text-status-warning px-2 py-0.5 rounded-full font-semibold flex-shrink-0 ${size}`}
      >
        <Circle size={6} className="fill-current status-dot-running" />
        {label}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium flex-shrink-0 min-w-0 ${size} ${TONE_CLASS[tone] ?? TONE_CLASS.muted}`}
    >
      <Circle size={6} className="fill-current flex-shrink-0" />
      {label}
      {toolChip}
    </span>
  );
}
