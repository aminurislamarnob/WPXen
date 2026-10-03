// Loading placeholders for Tasks, shaped like what they stand in for — the
// list's rows, an issue or PR's details, a project board — so the page
// doesn't jump when the data lands. They pulse unless the system asks for
// reduced motion.

// Varied, fixed widths so stacked rows read as text rather than a grid of
// identical bars, and don't reshuffle between renders.
const WIDTHS = ['72%', '54%', '86%', '63%', '45%', '78%', '58%', '68%'];
const width = (i, offset = 0) => WIDTHS[(i + offset) % WIDTHS.length];

export function Bone({ className = '', style }) {
  return (
    <span
      aria-hidden="true"
      className={`block rounded-md bg-muted motion-safe:animate-pulse ${className}`}
      style={style}
    />
  );
}

// Rows for the Issues / PRs tables. `grid` is the table's own column
// template; `cells` is how many trailing columns hold a pill-sized value.
export function RowsSkeleton({ grid, cells = 3, rows = 8 }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={`grid ${grid} gap-3 px-4 py-2.5 items-center border-b border-border last:border-b-0`}
        >
          <span className="flex items-center gap-1.5">
            <Bone className="size-3.5 rounded-full" />
            <Bone className="h-3 w-8" />
          </span>
          <span className="min-w-0 space-y-1.5">
            <Bone className="h-3.5" style={{ width: width(i) }} />
            <span className="flex items-center gap-1.5">
              <Bone className="h-2.5 w-14" />
              <Bone className="h-3.5 w-20 rounded-sm" />
              {i % 3 === 0 && <Bone className="h-3.5 w-12 rounded-full" />}
            </span>
          </span>
          {Array.from({ length: cells }, (_, c) => (
            <Bone key={c} className="h-5 w-16 rounded-full" />
          ))}
          <Bone className="h-3 w-12" />
          <span />
        </div>
      ))}
    </div>
  );
}

// A comment card: avatar, header strip, a few lines of body.
function CommentSkeleton({ lines = 3, offset = 0 }) {
  return (
    <div className="flex gap-3">
      <Bone className="size-7 flex-shrink-0 rounded-full" />
      <div className="flex-1 min-w-0 bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-9 border-b border-border bg-tertiary">
          <Bone className="h-3 w-20" />
          <Bone className="h-3 w-16" />
        </div>
        <div className="px-4 py-3 space-y-2">
          {Array.from({ length: lines }, (_, i) => (
            <Bone key={i} className="h-3" style={{ width: width(i, offset) }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SidebarSkeleton({ sections = 4 }) {
  return (
    <aside>
      {Array.from({ length: sections }, (_, i) => (
        <div key={i} className="py-3 border-b border-border last:border-b-0 space-y-2">
          <Bone className="h-2.5 w-16" />
          <Bone className="h-4" style={{ width: width(i, 3) }} />
        </div>
      ))}
    </aside>
  );
}

// An issue's or PR's details: title, meta line, (PR tabs,) the conversation
// and the sidebar.
export function DetailsSkeleton({ tabs = false }) {
  return (
    <div role="status" aria-label="Loading">
      <Bone className="h-6 w-2/3" />
      <div className="mt-3 mb-5 flex items-center gap-2">
        <Bone className="h-6 w-16 rounded-full" />
        <Bone className="h-3 w-72" />
      </div>
      {tabs && <Bone className="mb-4 h-8 w-72" />}
      <div className="grid grid-cols-[1fr_220px] gap-6 items-start">
        <div className="space-y-4">
          <CommentSkeleton lines={5} />
          <div className="flex items-center gap-3 pl-[6px]">
            <Bone className="size-[18px] rounded-full" />
            <Bone className="h-3 w-56" />
          </div>
          <CommentSkeleton lines={2} offset={2} />
        </div>
        <SidebarSkeleton sections={tabs ? 5 : 4} />
      </div>
    </div>
  );
}

// A PR's Files or Checks list: icon, a name, a couple of small values.
export function ListSkeleton({ rows = 6 }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="bg-card border border-border rounded-xl shadow-sm overflow-hidden"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-2.5 px-4 py-2.5 border-b border-border last:border-b-0"
        >
          <Bone className="size-3.5 rounded-full" />
          <Bone className="h-3" style={{ width: width(i, 1) }} />
          <span className="flex-1" />
          <Bone className="h-3 w-8" />
          <Bone className="h-3 w-8" />
        </div>
      ))}
    </div>
  );
}

// A project board: a few columns of cards of differing heights.
export function BoardSkeleton({ columns = 4 }) {
  return (
    <div role="status" aria-label="Loading" className="flex gap-3 overflow-hidden pb-2">
      {Array.from({ length: columns }, (_, c) => (
        <div
          key={c}
          className="w-[260px] flex-shrink-0 rounded-xl border border-border bg-tertiary/60 p-2"
        >
          <div className="flex items-center gap-2 px-1 pb-2">
            <Bone className="size-2.5 rounded-full" />
            <Bone className="h-3 w-20" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: 4 - (c % 3) }, (_, i) => (
              <div
                key={i}
                className="bg-card border border-border rounded-lg shadow-sm px-3 py-2 space-y-2"
              >
                <Bone className="h-3" style={{ width: width(i, c) }} />
                {(i + c) % 2 === 0 && <Bone className="h-3 w-1/2" />}
                <div className="flex items-center justify-between">
                  <Bone className="h-2.5 w-20" />
                  <Bone className="size-5 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
