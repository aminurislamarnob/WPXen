import { CheckCircle, CircleDot, CircleSlash } from 'lucide-react';
import { Tooltip } from '../ui';
import { labelColor } from '../../lib/tasks';

// Small pieces the Tasks list and details share.

export function stateIcon(item) {
  if (item.state === 'open') return CircleDot;
  return item.stateReason === 'not_planned' ? CircleSlash : CheckCircle;
}

export function StateBadge({ item, size = 'sm' }) {
  const open = item.state === 'open';
  const Icon = stateIcon(item);
  const big = size === 'md';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${
        big ? 'px-2.5 h-6 text-[12px]' : 'px-2 h-5 text-[11px]'
      } ${
        open
          ? 'border-status-running/40 text-status-running bg-status-running/10'
          : 'border-border text-muted-foreground'
      }`}
    >
      <Icon size={big ? 13 : 11} strokeWidth={2.2} />
      {open ? 'Open' : 'Closed'}
    </span>
  );
}

export function LabelChip({ label }) {
  const color = labelColor(label.color);
  return (
    <span className="flex-shrink-0 inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-[10.5px]">
      {color && (
        <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      )}
      {label.name}
    </span>
  );
}

export function Avatar({ person, size = 20, ring = true }) {
  const cls = `rounded-full flex-shrink-0 ${ring ? 'ring-2 ring-card' : ''}`;
  const style = { width: size, height: size };
  return person?.avatarUrl ? (
    <img src={person.avatarUrl} alt={person.login} className={cls} style={style} />
  ) : (
    <span className={`${cls} bg-muted`} style={style} />
  );
}

export function AvatarStack({ people, max = 4 }) {
  if (!people?.length)
    return <span className="text-[12px] text-muted-foreground">–</span>;
  return (
    <div className="flex -space-x-1.5">
      {people.slice(0, max).map((p) => (
        <Tooltip key={p.login} label={p.login}>
          <Avatar person={p} />
        </Tooltip>
      ))}
    </div>
  );
}
