import { X } from 'lucide-react';

// Shared bits of the Office side panel (agent list and inspector).

export function PanelHeader({ title, eyebrow, closeLabel, onClose }) {
  return (
    <div className="flex items-start gap-2 px-4 pt-3.5 pb-2.5 flex-shrink-0">
      <div className="flex-1 min-w-0">
        {eyebrow}
        {typeof title === 'string' ? (
          <p className="text-[14px] font-semibold text-foreground truncate">{title}</p>
        ) : (
          title
        )}
      </div>
      <button
        onClick={onClose}
        aria-label={closeLabel}
        title={closeLabel}
        className="p-1 -mr-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent flex-shrink-0"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * The project's team colour, the same one its pod carpet and floor sign use in
 * the scene — data from the scene palette, like the room tab dots.
 */
export function TeamSwatch({ color }) {
  return (
    <span
      className="w-2 h-2 rounded-sm flex-shrink-0"
      style={{ background: color }}
      aria-hidden
    />
  );
}
