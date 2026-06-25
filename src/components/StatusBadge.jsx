export function StatusBadge({ running, size = 'sm' }) {
  const sizeClasses = {
    xs: 'w-1.5 h-1.5',
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5',
  };

  return (
    <span
      className={`inline-block rounded-full flex-shrink-0 ${sizeClasses[size]} ${
        running ? 'bg-wp-green status-dot-running' : 'bg-gray-300'
      }`}
    />
  );
}

export function ServicePill({ name, running }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
        running
          ? 'bg-green-100 text-green-800'
          : 'bg-gray-100 text-gray-500'
      }`}
    >
      <StatusBadge running={running} size="xs" />
      {name}
    </span>
  );
}
