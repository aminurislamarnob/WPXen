import { ChevronRight, Check, CheckCircle, Loader } from 'lucide-react';

// Shared macOS System Settings primitives. Pages compose these instead of
// hand-rolling cards so the whole app reads as one native surface.

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
      <span className="text-[13px] font-semibold text-gray-800">{children}</span>
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
        <p className="text-[13px] text-gray-900 truncate">{title}</p>
        {subtitle && <p className="text-xs text-gray-500 truncate mt-0.5">{subtitle}</p>}
      </div>
      {children}
      {chevron && <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />}
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

// Colored rounded-square icon tile, System Settings style.
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

// macOS-style switch.
export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-[38px] h-[22px] rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-accent' : 'bg-gray-300'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`absolute left-0 top-0.5 w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// Page hero: big centered icon + title + description (like the General pane).
export function PageHero({ icon: Icon, color = 'gray', title, description }) {
  return (
    <div className="settings-card px-6 py-7 text-center mb-4">
      <IconTile icon={Icon} color={color} size={56} />
      <h1 className="text-[22px] font-bold text-gray-900 mt-3">{title}</h1>
      {description && (
        <p className="text-[13px] text-gray-500 mt-1 max-w-md mx-auto">{description}</p>
      )}
    </div>
  );
}

// Numbered step pills with connectors, for multi-step wizards. Completed steps
// go green with a check, the active step is accent, upcoming steps are muted.
export function StepIndicator({ current, steps, className = '' }) {
  return (
    <div className={`flex items-center gap-1 mb-6 ${className}`.trim()}>
      {steps.map((step, i) => (
        <div key={step} className="flex items-center">
          <div
            className={`flex items-center justify-center w-[22px] h-[22px] rounded-full text-[11px] font-semibold transition-all duration-300 ${
              i < current
                ? 'bg-wp-green text-white'
                : i === current
                  ? 'bg-accent text-white'
                  : 'bg-black/[0.06] text-gray-400 dark:bg-white/10'
            }`}
          >
            {i < current ? <Check size={12} strokeWidth={3} /> : i + 1}
          </div>
          {i < steps.length - 1 && (
            <div
              className={`w-6 h-[2px] mx-1 rounded-full transition-colors duration-300 ${
                i < current ? 'bg-wp-green' : 'bg-black/[0.08] dark:bg-white/10'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// Scrolling terminal-style log panel. The last line is highlighted with a
// spinner (in-progress); earlier lines get a green check.
export function ProgressLog({ messages, className = '' }) {
  return (
    <div
      className={`bg-zinc-900 rounded-xl p-4 h-40 overflow-y-auto font-mono text-xs ${className}`}
    >
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 ${i === messages.length - 1 ? 'text-white' : 'text-zinc-400'}`}
        >
          {i === messages.length - 1 ? (
            <Loader
              size={11}
              className="animate-spin mt-0.5 flex-shrink-0 text-wp-blue-light"
            />
          ) : (
            <CheckCircle size={11} className="mt-0.5 flex-shrink-0 text-wp-green" />
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
        <h1 className="text-[17px] font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
