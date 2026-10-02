import { Check } from 'lucide-react';

// The status mark at the head of an agent Session row (see agentStatus.cjs
// for the states). Fixed 14px box so rows align whatever the state.
export default function AgentStatusGlyph({ state }) {
  let mark;
  let label;
  if (state === 'working') {
    label = 'Working';
    mark = (
      <span
        className="agent-spinner block w-[11px] h-[11px]"
        // Pin every spinner to the same timeline origin so they turn in phase.
        onAnimationStart={(e) => {
          for (const a of e.currentTarget.getAnimations?.() || []) a.startTime = 0;
        }}
      />
    );
  } else if (state === 'done') {
    label = 'Done';
    mark = <Check size={13} strokeWidth={2.5} className="text-status-running" />;
  } else if (state === 'error') {
    label = 'Exited with an error';
    mark = <span className="block w-[7px] h-[7px] rounded-full bg-status-error" />;
  } else if (state === 'exited') {
    label = 'Exited';
    mark = <span className="block w-[7px] h-[7px] rounded-full bg-muted-foreground/60" />;
  } else {
    label = 'Idle';
    mark = (
      <span className="block w-[7px] h-[7px] rounded-full border border-muted-foreground/60" />
    );
  }
  return (
    <span
      className="w-[14px] h-[14px] flex items-center justify-center flex-shrink-0"
      title={label}
      aria-label={label}
      role="img"
    >
      {mark}
    </span>
  );
}
