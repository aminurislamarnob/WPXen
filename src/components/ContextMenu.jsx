import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

// A right-click menu at the pointer, after Orca's context menus: icon column,
// separators, submenus that open sideways, and a destructive item that asks
// for a second click. Used by the session tabs and the Agents sidebar.
//
// Items:
//   'separator'
//   { label, icon?, onClick, disabled?, danger?, hint? }
//   { label, icon?, items: [...] }          a submenu, opened on hover
//   { ..., confirm: 'Click again to end' }  needs a second click to run
//   { swatches: [{ label, value }], label, value, onPick }
//                                           a row of color dots (Orca's Tab
//                                           Color); value null is None
//
// An item without an icon keeps the icon column, so labels line up (Orca's
// `inset`). `hint` is a muted line under the item, e.g. why it's disabled.

const MARGIN = 8;

function clampToViewport(el, x, y) {
  const { width, height } = el.getBoundingClientRect();
  return {
    left: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
    top: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
  };
}

function MenuList({ items, onClose, menuRef, style, className = '' }) {
  const [openSub, setOpenSub] = useState(null); // { index, x, y }
  const [armed, setArmed] = useState(null); // index awaiting its confirm click
  const subRef = useRef(null);

  return (
    <>
      <div
        ref={menuRef}
        role="menu"
        className={`panel-menu fixed z-50 p-1 flex flex-col min-w-[13rem] max-w-[20rem] whitespace-nowrap ${className}`}
        style={style}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {items.map((item, i) => {
          if (item === 'separator') {
            return <div key={i} className="h-px bg-border my-1 -mx-1" />;
          }
          if (item.swatches) {
            return <SwatchRow key={i} item={item} onClose={onClose} />;
          }
          const Icon = item.icon;
          const hasSub = Array.isArray(item.items);
          const isArmed = armed === i;
          return (
            <div key={i}>
              <button
                type="button"
                role="menuitem"
                aria-haspopup={hasSub || undefined}
                aria-expanded={hasSub ? openSub?.index === i : undefined}
                disabled={item.disabled}
                onMouseEnter={(e) => {
                  if (!hasSub) return setOpenSub(null);
                  const r = e.currentTarget.getBoundingClientRect();
                  setOpenSub({
                    index: i,
                    x: r.right + 2,
                    left: r.left - 2,
                    y: r.top - 4,
                  });
                }}
                onClick={(e) => {
                  if (hasSub) {
                    const r = e.currentTarget.getBoundingClientRect();
                    setOpenSub({
                      index: i,
                      x: r.right + 2,
                      left: r.left - 2,
                      y: r.top - 4,
                    });
                    return;
                  }
                  if (item.confirm && !isArmed) return setArmed(i);
                  onClose();
                  item.onClick?.();
                }}
                className={`panel-item text-left ${
                  item.danger ? 'text-destructive' : ''
                } ${hasSub && openSub?.index === i ? 'bg-accent' : ''}`}
              >
                <span
                  className={`flex w-3.5 flex-shrink-0 justify-center ${
                    item.danger ? '' : 'text-muted-foreground'
                  }`}
                >
                  {Icon && <Icon size={14} />}
                </span>
                <span className="flex-1 truncate">
                  {isArmed ? item.confirm : item.label}
                </span>
                {hasSub && <ChevronRight size={14} className="text-muted-foreground" />}
              </button>
              {item.hint && (
                <p className="pl-[30px] pr-2 pb-1 text-[11.5px] leading-snug whitespace-normal text-muted-foreground">
                  {item.hint}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {openSub && (
        <SubMenu
          key={openSub.index}
          menuRef={subRef}
          items={items[openSub.index].items}
          x={openSub.x}
          parentLeft={openSub.left}
          y={openSub.y}
          onClose={onClose}
        />
      )}
    </>
  );
}

// Color dots under a small heading, after Orca's Tab Color row: the chosen
// one carries a ring, None is an empty circle with a slash.
function SwatchRow({ item, onClose }) {
  return (
    <div className="pt-1.5 pr-2.5 pb-1.5 pl-[30px]">
      <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
        {item.label}
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={item.label}>
        {item.swatches.map((sw) => {
          const selected = (item.value ?? null) === sw.value;
          return (
            <button
              key={sw.label}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={sw.label}
              title={sw.label}
              onClick={() => {
                onClose();
                item.onPick(sw.value);
              }}
              className={`relative flex size-4 items-center justify-center rounded-full border ${
                sw.value ? 'border-transparent' : 'border-muted-foreground/50'
              } ${selected ? 'ring-1 ring-foreground/70 ring-offset-1 ring-offset-popover' : ''}`}
              style={sw.value ? { backgroundColor: sw.value } : undefined}
            >
              {sw.value === null && (
                <span className="absolute block h-px w-3 rotate-45 bg-muted-foreground/80" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubMenu({ items, x, parentLeft, y, onClose, menuRef }) {
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width } = el.getBoundingClientRect();
    // No room on the right: open to the left of the parent instead.
    const flip = x + width + MARGIN > window.innerWidth;
    setPos(clampToViewport(el, flip ? parentLeft - width : x, y));
  }, [x, parentLeft, y, menuRef]);
  return (
    <MenuList
      items={items}
      onClose={onClose}
      menuRef={menuRef}
      style={pos}
      className="z-[51]"
    />
  );
}

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const rootRef = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    // Close on a press anywhere *outside* the menu (and its submenus).
    // Listening for every click on the window in capture phase closed the
    // menu before an item's own onClick ran: the item unmounted mid-click,
    // so no action ever fired.
    const outside = (e) => {
      if (!rootRef.current?.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', outside, { capture: true });
    window.addEventListener('contextmenu', outside, { capture: true });
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, { capture: true });
      window.removeEventListener('contextmenu', outside, { capture: true });
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // Keep the menu on screen when opened near the right or bottom edge.
  useLayoutEffect(() => {
    if (ref.current) setPos(clampToViewport(ref.current, x, y));
  }, [x, y]);

  return (
    <div ref={rootRef}>
      <MenuList items={items} onClose={onClose} menuRef={ref} style={pos} />
    </div>
  );
}
