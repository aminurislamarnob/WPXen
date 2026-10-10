import { useEffect } from 'react';

export default function TabContextMenu({ x, y, items, onClose }) {
  useEffect(() => {
    const onClick = () => onClose();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    // use capture to ensure it runs before React event delegation
    window.addEventListener('click', onClick, { capture: true });
    window.addEventListener('contextmenu', onClick, { capture: true });
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('click', onClick, { capture: true });
      window.removeEventListener('contextmenu', onClick, { capture: true });
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [onClose]);

  return (
    <div
      className="panel-menu fixed z-50 p-1 flex flex-col min-w-[180px] shadow-lg rounded-md border border-border"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item, i) => {
        if (item === 'separator') {
          return <div key={i} className="h-px bg-border my-1 mx-1" />;
        }
        return (
          <button
            key={i}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            disabled={item.disabled}
            className={`text-left px-2 py-1 text-[13px] rounded hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent ${item.danger ? 'text-destructive' : 'text-foreground'}`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
