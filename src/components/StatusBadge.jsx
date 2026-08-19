import { Circle } from 'lucide-react';

const SIZE_MAP = { xs: 6, sm: 8, md: 10 };

export function StatusBadge({ running, size = 'sm' }) {
  return (
    <Circle
      size={SIZE_MAP[size]}
      className={`fill-current flex-shrink-0 ${
        running ? 'text-status-running status-dot-running' : 'text-muted-foreground/50'
      }`}
    />
  );
}

export function ServicePill({ name, running }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-2 py-0.5 rounded-full text-xs font-medium ${
        running
          ? 'border-status-running/30 bg-status-running/10 text-status-running'
          : 'border-border bg-muted text-muted-foreground'
      }`}
    >
      <StatusBadge running={running} size="xs" />
      {name}
    </span>
  );
}
