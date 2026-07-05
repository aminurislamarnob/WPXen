import { ChevronRight } from 'lucide-react';

// Shared macOS System Settings primitives. Pages compose these instead of
// hand-rolling cards so the whole app reads as one native surface.

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

export function IconTile({ icon: Icon, color = 'blue', size = 26 }) {
  return (
    <span
      className={`icon-tile ${TILE_COLORS[color] || TILE_COLORS.blue}`}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.58)} strokeWidth={2.2} />
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
