import {
  CheckCircle,
  CircleDashed,
  CircleDot,
  FileDiff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MoreVertical,
  XCircle,
} from 'lucide-react';
import { Tooltip } from '../ui';
import { sessionsFor, timeAgo } from '../../lib/tasks';
import { LabelChip, StartButton } from './parts';

// The PRs tab's table: ID, title with its context, then GitHub's three
// verdicts — Review, Checks, Merge — and Updated. The values are already
// normalised by services/github.cjs (normalizeReview / Checks / Merge).

const GRID = 'grid-cols-[60px_1fr_108px_84px_92px_76px_72px_28px]';

function Pill({ tone = 'muted', icon: Icon, children, title }) {
  const tones = {
    good: 'border-status-running/40 text-status-running bg-status-running/10',
    bad: 'border-destructive/40 text-destructive bg-destructive/10',
    warn: 'border-status-warning/40 text-status-warning bg-status-warning/10',
    info: 'border-highlight/40 text-highlight bg-highlight/10',
    muted: 'border-border text-muted-foreground',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 h-5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {Icon && <Icon size={11} strokeWidth={2.2} />}
      {children}
    </span>
  );
}

const REVIEW = {
  approved: { tone: 'good', icon: CheckCircle, label: 'Approved' },
  'changes-requested': { tone: 'bad', icon: FileDiff, label: 'Changes' },
  'review-required': { tone: 'warn', icon: CircleDashed, label: 'Required' },
};

export function ReviewBadge({ review }) {
  const r = REVIEW[review];
  if (!r) return <span className="text-[12px] text-muted-foreground">–</span>;
  return (
    <Pill tone={r.tone} icon={r.icon}>
      {r.label}
    </Pill>
  );
}

export function ChecksBadge({ checks }) {
  if (!checks) return <span className="text-[12px] text-muted-foreground">–</span>;
  const title = `${checks.passing} passing · ${checks.failing} failing · ${checks.pending} pending`;
  if (checks.state === 'failing') {
    return (
      <Pill tone="bad" icon={XCircle} title={title}>
        {checks.failing}/{checks.total}
      </Pill>
    );
  }
  if (checks.state === 'pending') {
    return (
      <Pill tone="warn" icon={CircleDot} title={title}>
        {checks.pending}/{checks.total}
      </Pill>
    );
  }
  return (
    <Pill tone="good" icon={CheckCircle} title={title}>
      {checks.passing}/{checks.total}
    </Pill>
  );
}

const MERGE = {
  merged: { tone: 'info', icon: GitMerge, label: 'Merged' },
  closed: { tone: 'muted', icon: GitPullRequestClosed, label: 'Closed' },
  draft: { tone: 'muted', icon: GitPullRequestDraft, label: 'Draft' },
  conflicts: { tone: 'bad', icon: XCircle, label: 'Conflicts' },
  ready: { tone: 'good', icon: CheckCircle, label: 'Ready' },
  blocked: { tone: 'warn', icon: CircleDashed, label: 'Blocked' },
  behind: { tone: 'warn', icon: CircleDashed, label: 'Behind' },
};

export function MergeBadge({ merge }) {
  const m = MERGE[merge];
  if (!m) return <span className="text-[12px] text-muted-foreground">–</span>;
  return (
    <Pill tone={m.tone} icon={m.icon}>
      {m.label}
    </Pill>
  );
}

export function pullIcon(pr) {
  if (pr.merge === 'merged') return { Icon: GitMerge, tone: 'text-highlight' };
  if (pr.state === 'closed')
    return { Icon: GitPullRequestClosed, tone: 'text-destructive' };
  if (pr.draft) return { Icon: GitPullRequestDraft, tone: 'text-muted-foreground' };
  return { Icon: GitPullRequest, tone: 'text-status-running' };
}

export default function PullTable({
  items,
  loading,
  onOpen,
  onMenu,
  linked,
  onStart,
  onOpenSession,
}) {
  const now = Date.now();
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div
        className={`grid ${GRID} gap-3 px-4 h-9 items-center border-b border-border text-[11px] font-medium uppercase tracking-wide text-muted-foreground`}
      >
        <span>ID</span>
        <span>Title / context</span>
        <span>Review</span>
        <span>Checks</span>
        <span>Merge</span>
        <span>Updated</span>
        <span />
        <span />
      </div>
      {loading ? (
        <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
          Nothing to show.
        </div>
      ) : (
        items.map((pr) => {
          const { Icon, tone } = pullIcon(pr);
          return (
            <div
              key={`${pr.repo}#${pr.number}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(pr)}
              onKeyDown={(e) => e.key === 'Enter' && onOpen(pr)}
              className={`grid ${GRID} gap-3 px-4 py-2.5 items-center border-b border-border last:border-b-0 cursor-pointer hover:bg-accent/50`}
            >
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground tabular-nums">
                <Icon size={14} className={tone} strokeWidth={2} />#{pr.number}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[13px] font-medium text-foreground truncate">
                    {pr.title}
                  </span>
                  {pr.draft && (
                    <span className="flex-shrink-0 rounded-sm border border-border px-1 text-[10.5px] text-muted-foreground">
                      Draft
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-[11.5px] text-muted-foreground min-w-0">
                  <span className="truncate">{pr.author}</span>
                  <span className="flex-shrink-0 rounded-sm bg-muted px-1.5 font-mono text-[10.5px]">
                    {pr.repo}
                  </span>
                  {pr.headRef && (
                    <span
                      className="truncate font-mono text-[10.5px]"
                      title={`${pr.headRef} → ${pr.baseRef}`}
                    >
                      {pr.headRef} → {pr.baseRef}
                    </span>
                  )}
                  {pr.labels.slice(0, 2).map((l) => (
                    <LabelChip key={l.name} label={l} />
                  ))}
                </div>
              </div>
              <span>
                <ReviewBadge review={pr.review} />
              </span>
              <span>
                <ChecksBadge checks={pr.checks} />
              </span>
              <span>
                <MergeBadge merge={pr.merge} />
              </span>
              <span className="text-[12px] text-muted-foreground">
                {timeAgo(pr.updatedAt, now)}
              </span>
              <span>
                <StartButton
                  sessions={sessionsFor(linked, pr)}
                  onStart={() => onStart(pr)}
                  onOpenSession={onOpenSession}
                />
              </span>
              <Tooltip label="More">
                <button
                  className="-m-1 p-1 rounded-md hover:bg-accent"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMenu(pr, e.currentTarget);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <MoreVertical size={14} className="text-muted-foreground" />
                </button>
              </Tooltip>
            </div>
          );
        })
      )}
    </div>
  );
}
