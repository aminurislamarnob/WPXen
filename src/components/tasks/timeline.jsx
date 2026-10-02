import {
  CheckCircle,
  CircleDot,
  CircleSlash,
  FileDiff,
  GitMerge,
  GitPullRequest,
  Link2,
  MessageSquare,
  Tag,
  UserRound,
  XCircle,
} from 'lucide-react';
import { timeAgo } from '../../lib/tasks';
import { Avatar, LabelChip } from './parts';
import { Markdown } from './markdown';

// The conversation shared by issue and PR details: comment cards, one-line
// events, and review verdicts, from github.cjs's normalised timeline.

const REVIEW_VERDICT = {
  approved: {
    verb: 'approved these changes',
    icon: CheckCircle,
    tone: 'text-status-running',
    label: 'Approved',
  },
  'changes-requested': {
    verb: 'requested changes',
    icon: FileDiff,
    tone: 'text-destructive',
    label: 'Changes requested',
  },
  commented: {
    verb: 'reviewed',
    icon: MessageSquare,
    tone: undefined,
    label: 'Commented',
  },
  dismissed: {
    verb: 'had a review dismissed',
    icon: XCircle,
    tone: undefined,
    label: 'Dismissed',
  },
};

function VerdictBadge({ state }) {
  const v = REVIEW_VERDICT[state];
  if (!v || state === 'commented') return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-[10.5px] ${v.tone || ''}`}
    >
      <v.icon size={10} strokeWidth={2.2} />
      {v.label}
    </span>
  );
}

export function CommentCard({
  author,
  at,
  body,
  url,
  onLink,
  now,
  empty,
  action,
  children,
  verb = 'commented',
  badge = null,
}) {
  return (
    <div className="flex gap-3">
      <Avatar person={author} size={28} ring={false} />
      <div className="flex-1 min-w-0 bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 h-9 border-b border-border bg-tertiary text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{author?.login || 'ghost'}</span>
          <span>{verb}</span>
          {badge}
          {url ? (
            <button className="hover:underline" onClick={() => onLink(url)}>
              {timeAgo(at, now)}
            </button>
          ) : (
            <span>{timeAgo(at, now)}</span>
          )}
          <div className="flex-1" />
          {action}
        </div>
        <div className="px-4 py-3">
          {children || <Markdown text={body} onLink={onLink} empty={empty} />}
        </div>
      </div>
    </div>
  );
}

// A one-line event: an icon in the timeline's rail and a sentence.
function EventRow({ icon: Icon, tone = 'text-muted-foreground', children }) {
  return (
    <div className="flex items-center gap-3 pl-[6px] text-[12.5px] text-muted-foreground">
      <span
        className={`size-[18px] flex items-center justify-center rounded-full bg-muted ${tone}`}
      >
        <Icon size={11} strokeWidth={2.2} />
      </span>
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">{children}</div>
    </div>
  );
}

function Actor({ person }) {
  return <span className="font-medium text-foreground">{person?.login || 'ghost'}</span>;
}

export function TimelineEvent({ event, now, onLink }) {
  const when = <span>{timeAgo(event.at, now)}</span>;
  switch (event.type) {
    case 'comment':
      return (
        <CommentCard
          author={event.actor}
          at={event.at}
          body={event.body}
          url={event.url}
          onLink={onLink}
          now={now}
          empty="No content."
        />
      );
    case 'closed':
      return (
        <EventRow
          icon={event.stateReason === 'not_planned' ? CircleSlash : CheckCircle}
          tone="text-highlight"
        >
          <Actor person={event.actor} />
          <span>
            closed this
            {event.stateReason === 'not_planned' ? ' as not planned' : ' as completed'}
          </span>
          {when}
        </EventRow>
      );
    case 'merged':
      return (
        <EventRow icon={GitMerge} tone="text-highlight">
          <Actor person={event.actor} />
          <span>merged this</span>
          {when}
        </EventRow>
      );
    case 'review': {
      const verdict = REVIEW_VERDICT[event.state];
      // A review's summary reads as a comment with its verdict; a bare
      // verdict is a one-line event.
      if (event.body.trim()) {
        return (
          <CommentCard
            author={event.actor}
            at={event.at}
            body={event.body}
            url={event.url}
            onLink={onLink}
            now={now}
            verb={verdict.verb}
            badge={<VerdictBadge state={event.state} />}
          />
        );
      }
      return (
        <EventRow icon={verdict.icon} tone={verdict.tone}>
          <Actor person={event.actor} />
          <span>{verdict.verb}</span>
          {when}
        </EventRow>
      );
    }
    case 'reopened':
      return (
        <EventRow icon={CircleDot} tone="text-status-running">
          <Actor person={event.actor} />
          <span>reopened this</span>
          {when}
        </EventRow>
      );
    case 'labeled':
    case 'unlabeled':
      return (
        <EventRow icon={Tag}>
          <Actor person={event.actor} />
          <span>{event.type === 'labeled' ? 'added' : 'removed'}</span>
          <LabelChip label={event.label} />
          {when}
        </EventRow>
      );
    case 'assigned':
    case 'unassigned': {
      const self = event.actor?.login === event.assignee?.login;
      return (
        <EventRow icon={UserRound}>
          <Actor person={event.actor} />
          <span>
            {event.type === 'assigned'
              ? self
                ? 'self-assigned this'
                : 'assigned'
              : self
                ? 'removed their assignment'
                : 'unassigned'}
          </span>
          {!self && <Actor person={event.assignee} />}
          {when}
        </EventRow>
      );
    }
    case 'referenced': {
      const src = event.source;
      const Icon = src.kind === 'pr' ? (src.merged ? GitMerge : GitPullRequest) : Link2;
      return (
        <EventRow icon={Icon} tone={src.merged ? 'text-highlight' : undefined}>
          <Actor person={event.actor} />
          <span>mentioned this in</span>
          <button
            className="min-w-0 truncate text-foreground hover:underline"
            onClick={() => src.url && onLink(src.url)}
          >
            {src.title} <span className="text-muted-foreground">#{src.number}</span>
          </button>
          {when}
        </EventRow>
      );
    }
    default:
      return null;
  }
}

export function SidebarSection({ title, children }) {
  return (
    <div className="py-3 border-b border-border last:border-b-0">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

export function None() {
  return <span className="text-[12.5px] text-muted-foreground">None</span>;
}
