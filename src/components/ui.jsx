import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Check, CheckCircle, Loader } from 'lucide-react';

// Shared UI primitives. Pages compose these instead of hand-rolling cards so
// the whole app reads as one surface. Colors come from the semantic tokens in
// src/index.css — never hardcode a hex here.

// Common button. All shape/size/color lives in the .btn-* classes
// (src/index.css) — this just maps a `variant` to the right class so every
// button in the app shares one design. Pass `className` for layout-only
// extras (flex-1, w-full, justify-center); design new buttons by adding a
// variant here + a .btn-* rule, never by hand-rolling styles at the call site.
const BUTTON_VARIANTS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  danger: 'btn-danger',
  ghost: 'btn-ghost',
};

export function Button({
  variant = 'secondary',
  type = 'button',
  className = '',
  children,
  ...props
}) {
  const base = BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.secondary;
  return (
    <button type={type} className={`${base} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

// Grouped rounded card holding hairline-divided rows.
export function Card({ className = '', children }) {
  return <div className={`settings-card ${className}`}>{children}</div>;
}

// Bold little heading above a card group.
export function SectionLabel({ children, right }) {
  return (
    <div className="flex items-center justify-between mb-2 px-1">
      <span className="text-[13px] font-semibold text-foreground">{children}</span>
      {right}
    </div>
  );
}

// One row: [icon tile] label/sublabel ......... controls [chevron]
// Rows after the first draw a hairline divider (via CSS sibling rule).
export function Row({
  icon,
  title,
  subtitle,
  children,
  onClick,
  chevron,
  className = '',
}) {
  const content = (
    <>
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-foreground truncate">{title}</p>
        {subtitle && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p>
        )}
      </div>
      {children}
      {chevron && (
        <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
      )}
    </>
  );
  if (onClick) {
    return (
      <button onClick={onClick} className={`settings-row settings-row-btn ${className}`}>
        {content}
      </button>
    );
  }
  return <div className={`settings-row ${className}`}>{content}</div>;
}

// A settings row that knows about search. `id` ties it to an entry in
// src/lib/settingsRegistry.js; when the settings search is active the section
// passes down the visible id list and non-matching rows drop out. Everything
// else is a plain Row, so the shared shape stays in one place.
export function SettingsRow({ id, visible, ...props }) {
  if (visible && !visible.includes(id)) return null;
  return <Row {...props} />;
}

// Colored rounded-square icon tile. A deliberate WPHerd carve-out: Superset's
// iconography is all-monochrome, but the colored tiles are part of this app's
// identity, so they stay in the sidebar, page heroes and settings rows.
// size: tile square in px; icon scales with it.
const TILE_COLORS = {
  blue: 'bg-[#0a7aff]',
  green: 'bg-[#28c840]',
  gray: 'bg-[#8e8e93]',
  orange: 'bg-[#ff9500]',
  purple: 'bg-[#af52de]',
  red: 'bg-[#ff3b30]',
  teal: 'bg-[#30b0c7]',
  indigo: 'bg-[#5856d6]',
  pink: 'bg-[#ff2d55]',
};

export function IconTile({ icon: Icon, color = 'blue', size = 26, className = '' }) {
  // Radius scales with the tile so big hero tiles get macOS-style rounding while
  // small row/sidebar tiles stay at ~7px.
  const radius = Math.max(7, Math.round(size * 0.26));
  return (
    <span
      className={`icon-tile ${TILE_COLORS[color] || TILE_COLORS.blue} ${className}`.trim()}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <Icon size={Math.round(size * 0.54)} strokeWidth={2.2} />
    </span>
  );
}

// Switch. Superset's compact dimensions, WPHerd's blue for the checked state
// (its `primary` is monochrome, which reads as "disabled" for a toggle).
export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-highlight' : 'bg-input'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`absolute left-0 top-px w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
          checked ? 'translate-x-[15px]' : 'translate-x-px'
        }`}
      />
    </button>
  );
}

// Segmented control (Superset's Tabs): a muted trough holding raised pills.
// `tabs` is [{ value, label, icon? }]; the active pill floats on the page
// background.
export function SegmentedTabs({ tabs, value, onChange, className = '' }) {
  return (
    <div
      role="tablist"
      className={`inline-flex h-8 items-center rounded-lg bg-muted p-[3px] ${className}`.trim()}
    >
      {tabs.map(({ value: v, label, icon: Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(v)}
            className={`inline-flex h-full items-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium transition-colors ${
              active
                ? 'bg-background text-foreground shadow-sm dark:bg-input/60'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {Icon && <Icon size={13} strokeWidth={2.2} />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Page hero: big centered icon + title + description (like the General pane).
export function PageHero({ icon: Icon, color = 'gray', title, description }) {
  return (
    <div className="settings-card px-6 py-7 text-center mb-4">
      <IconTile icon={Icon} color={color} size={56} />
      <h1 className="text-[22px] font-bold text-foreground mt-3">{title}</h1>
      {description && (
        <p className="text-[13px] text-muted-foreground mt-1 max-w-md mx-auto">
          {description}
        </p>
      )}
    </div>
  );
}

// Numbered step pills with connectors, for multi-step wizards. Completed steps
// go green with a check, the active step is blue, upcoming steps are muted.
export function StepIndicator({ current, steps, className = '' }) {
  return (
    <div className={`flex items-center gap-1 mb-6 ${className}`.trim()}>
      {steps.map((step, i) => (
        <div key={step} className="flex items-center">
          <div
            className={`flex items-center justify-center w-[22px] h-[22px] rounded-full text-[11px] font-semibold transition-all duration-300 ${
              i < current
                ? 'bg-status-running text-white'
                : i === current
                  ? 'bg-highlight text-highlight-foreground'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            {i < current ? <Check size={12} strokeWidth={3} /> : i + 1}
          </div>
          {i < steps.length - 1 && (
            <div
              className={`w-6 h-[2px] mx-1 rounded-full transition-colors duration-300 ${
                i < current ? 'bg-status-running' : 'bg-border'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// Scrolling terminal-style log panel. The last line is highlighted with a
// spinner (in-progress); earlier lines get a green check. Like Superset's
// terminals this sits on the app background rather than in its own dark box.
export function ProgressLog({ messages, className = '' }) {
  return (
    <div
      className={`bg-background border border-border rounded-lg p-4 h-40 overflow-y-auto font-mono text-xs ${className}`}
    >
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 ${i === messages.length - 1 ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {i === messages.length - 1 ? (
            <Loader
              size={11}
              className="animate-spin mt-0.5 flex-shrink-0 text-highlight"
            />
          ) : (
            <CheckCircle size={11} className="mt-0.5 flex-shrink-0 text-status-running" />
          )}
          <span>{msg}</span>
        </div>
      ))}
    </div>
  );
}

// Compact page header for list-style panes (title left, actions right).
export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div>
        <h1 className="text-[17px] font-bold text-foreground">{title}</h1>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

// Keycap chip for a shortcut. Inside a Tooltip the pill is an inverted
// surface, so the cap tints with the page background at low alpha; standalone
// (`tone="solid"`) it sits on the muted fill like Superset's <Kbd>.
export function Kbd({ children, tone = 'inverted' }) {
  return (
    <kbd
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-sans text-[11px] font-medium leading-none ${
        tone === 'solid'
          ? 'bg-muted text-muted-foreground'
          : 'bg-background/20 text-inherit'
      }`}
    >
      {children}
    </kbd>
  );
}

const TOOLTIP_GAP = 6; // px between the trigger and the pill
const TOOLTIP_MARGIN = 8; // px minimum clearance from the window edge

// Place the pill on `side` of the trigger, centered, then clamp it inside the
// window so a control near an edge still shows its label in full.
function placeTooltip(trigger, tip, side) {
  let top, left;
  switch (side) {
    case 'top':
      top = trigger.top - tip.height - TOOLTIP_GAP;
      left = trigger.left + trigger.width / 2 - tip.width / 2;
      break;
    case 'left':
      top = trigger.top + trigger.height / 2 - tip.height / 2;
      left = trigger.left - tip.width - TOOLTIP_GAP;
      break;
    case 'right':
      top = trigger.top + trigger.height / 2 - tip.height / 2;
      left = trigger.right + TOOLTIP_GAP;
      break;
    default:
      top = trigger.bottom + TOOLTIP_GAP;
      left = trigger.left + trigger.width / 2 - tip.width / 2;
  }
  const clamp = (v, max) => Math.min(Math.max(TOOLTIP_MARGIN, v), max - TOOLTIP_MARGIN);
  return {
    top: clamp(top, window.innerHeight - tip.height),
    left: clamp(left, window.innerWidth - tip.width),
  };
}

// Hover tooltip: a pill on an inverted surface holding a label and, when the
// action has a shortcut, its keycaps — e.g. `keys={['⌘', 'B']}`.
//
//   <Tooltip label="Toggle sidebar" keys={['⌘', 'B']}>
//     <button …>…</button>
//   </Tooltip>
//
// The single child is cloned (not wrapped) so it keeps its place in the parent
// layout; it must be a host element that accepts a ref. The pill portals to
// <body> and is pointer-events-none, so it never intercepts clicks and never
// gets clipped by an overflow-hidden ancestor. Prefer this over the native
// `title` attribute — don't set both, or macOS draws a second tooltip.
export function Tooltip({ label, keys, side = 'bottom', delay = 300, children }) {
  const triggerRef = useRef(null);
  const tipRef = useRef(null);
  const timerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    setOpen(false);
    setCoords(null);
  }, []);

  const show = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Measure once mounted, then position. Until then the pill is laid out but
  // invisible, so it's sized without flashing in the wrong spot.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tipRef.current) return;
    setCoords(
      placeTooltip(
        triggerRef.current.getBoundingClientRect(),
        tipRef.current.getBoundingClientRect(),
        side
      )
    );
  }, [open, side, label, keys]);

  // Anything that can move the trigger out from under the pill dismisses it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [open, hide]);

  const childRef = children.ref;
  const trigger = cloneElement(children, {
    ref: (node) => {
      triggerRef.current = node;
      if (typeof childRef === 'function') childRef(node);
      else if (childRef) childRef.current = node;
    },
    onMouseEnter: (e) => {
      children.props.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e) => {
      children.props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e) => {
      children.props.onFocus?.(e);
      show();
    },
    onBlur: (e) => {
      children.props.onBlur?.(e);
      hide();
    },
    // Dismiss on activation, so the pill doesn't hang over the result.
    onClick: (e) => {
      children.props.onClick?.(e);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            style={{
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              visibility: coords ? 'visible' : 'hidden',
            }}
            className="fixed z-[70] pointer-events-none flex items-center gap-2 whitespace-nowrap rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-md animate-fade-in"
          >
            {label}
            {keys?.length > 0 && (
              <span className="flex items-center gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            )}
          </div>,
          document.body
        )}
    </>
  );
}

// Modal confirm dialog on the `.panel` popover surface. Used for destructive
// actions (discard changes, delete file) so we never lean on window.confirm.
// Enter confirms, Escape cancels; clicking the backdrop cancels.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel,
  children,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
      if (e.key === 'Enter') onConfirm?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="panel w-[320px] max-w-[90vw] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13.5px] font-semibold text-foreground">{title}</p>
        {description && (
          <p className="mt-1.5 text-[12.5px] leading-snug text-muted-foreground">
            {description}
          </p>
        )}
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
