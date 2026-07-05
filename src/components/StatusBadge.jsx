import { Circle } from 'lucide-react';

const SIZE_MAP = { xs: 6, sm: 8, md: 10 };

export function StatusBadge({ running, size = 'sm' }) {
  return (
    <Circle
      size={SIZE_MAP[size]}
      className={`fill-current flex-shrink-0 ${
        running ? 'text-wp-green status-dot-running' : 'text-gray-300'
      }`}
    />
  );
}

export function ServicePill({ name, running }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
        running
          ? 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300'
          : 'bg-gray-100 text-gray-500'
      }`}
    >
      <StatusBadge running={running} size="xs" />
      {name}
    </span>
  );
}
