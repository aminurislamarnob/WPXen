import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle,
  CircleDot,
  CircleSlash,
  Copy,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Link2,
  RefreshCw,
  Tag,
  UserRound,
} from 'lucide-react';
import { Tooltip } from '../ui';
import { useOpenLink } from '../../lib/useOpenLink';
import { previewLinkTarget, renderMarkdownHtml } from '../../lib/notePreview';
import { timeAgo } from '../../lib/tasks';
import { Avatar, LabelChip, StateBadge } from './parts';

// One issue inside Tasks: header, the description as GitHub-flavoured
// markdown, the timeline of comments and key events, and a read-only sidebar.
// The data is `services/github.cjs` getIssue — the issue plus a normalised
// timeline — fetched on open and again on ↻.

function Markdown({ text, onLink, empty }) {
  // Sanitised by DOMPurify in renderMarkdownHtml.
  const html = useMemo(() => renderMarkdownHtml(text), [text]);
  if (!String(text || '').trim()) {
    return <p className="text-[13px] italic text-muted-foreground">{empty}</p>;
  }
  // Links never navigate the app's own window; they go through the app's
  // link setting instead.
  const onClick = (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const url = previewLinkTarget(a.getAttribute('href'));
    if (url) onLink(url);
  };
  return (
    <div
      className="note-preview break-words"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CommentCard({ author, at, body, url, onLink, now, empty }) {
  return (
    <div className="flex gap-3">
      <Avatar person={author} size={28} ring={false} />
      <div className="flex-1 min-w-0 bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 h-9 border-b border-border bg-tertiary text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{author?.login || 'ghost'}</span>
          <span>commented</span>
          {url ? (
            <button className="hover:underline" onClick={() => onLink(url)}>
              {timeAgo(at, now)}
            </button>
          ) : (
            <span>{timeAgo(at, now)}</span>
          )}
        </div>
        <div className="px-4 py-3">
          <Markdown text={body} onLink={onLink} empty={empty} />
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

function TimelineEvent({ event, now, onLink }) {
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

function SidebarSection({ title, children }) {
  return (
    <div className="py-3 border-b border-border last:border-b-0">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function None() {
  return <span className="text-[12.5px] text-muted-foreground">None</span>;
}

export default function IssueDetails({ repo, number, siteId, onBack }) {
  const openLink = useOpenLink();
  const [data, setData] = useState(null); // { issue, timeline, truncated } | { error }
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    async ({ force = false } = {}) => {
      setLoading(true);
      try {
        setData(await window.electronAPI.tasksIssue({ repo, number, force }));
      } finally {
        setLoading(false);
      }
    },
    [repo, number]
  );

  useEffect(() => {
    load();
  }, [load]);

  const onLink = (url) => openLink(url, siteId);
  const issue = data?.issue;
  const now = Date.now();

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(issue.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — Open on GitHub still works
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <button className="btn btn-ghost !px-2" onClick={onBack}>
          <ArrowLeft size={14} />
          Issues
        </button>
        <span className="font-mono text-[12px] text-muted-foreground">
          {repo} #{number}
        </span>
        <div className="flex-1" />
        <Tooltip label="Refresh">
          <button
            className="btn btn-secondary !px-2"
            aria-label="Refresh"
            onClick={() => load({ force: true })}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </Tooltip>
        {issue && (
          <>
            <button className="btn btn-secondary" onClick={copyLink}>
              <Copy size={13} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button className="btn btn-secondary" onClick={() => onLink(issue.url)}>
              <ExternalLink size={13} />
              Open on GitHub
            </button>
          </>
        )}
      </div>

      {data?.error ? (
        <div className="bg-card border border-border rounded-xl shadow-sm px-6 py-10 text-center">
          <p className="text-[14px] font-medium text-foreground">
            Couldn’t load this issue
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{data.error.message}</p>
          <button
            className="btn btn-secondary mt-4"
            onClick={() => load({ force: true })}
          >
            Try again
          </button>
        </div>
      ) : !issue ? (
        <div className="px-4 py-16 text-center text-[13px] text-muted-foreground">
          Loading…
        </div>
      ) : (
        <>
          <h1 className="text-[20px] font-semibold text-foreground leading-snug">
            {issue.title}{' '}
            <span className="font-normal text-muted-foreground">#{issue.number}</span>
          </h1>
          <div className="mt-2 mb-5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <StateBadge item={issue} size="md" />
            <span>
              <span className="font-medium text-foreground">
                {issue.author || 'ghost'}
              </span>{' '}
              opened this {timeAgo(issue.createdAt, now)} · updated{' '}
              {timeAgo(issue.updatedAt, now)}
            </span>
          </div>

          <div className="grid grid-cols-[1fr_220px] gap-6 items-start">
            <div className="min-w-0 space-y-4">
              <CommentCard
                author={{ login: issue.author }}
                at={issue.createdAt}
                body={issue.body}
                url={issue.url}
                onLink={onLink}
                now={now}
                empty="No description provided."
              />
              {data.timeline.map((event) => (
                <TimelineEvent key={event.id} event={event} now={now} onLink={onLink} />
              ))}
              {data.truncated && (
                <p className="text-[12px] text-muted-foreground">
                  Older activity is on{' '}
                  <button
                    className="text-highlight hover:underline"
                    onClick={() => onLink(issue.url)}
                  >
                    GitHub
                  </button>
                  .
                </p>
              )}
            </div>

            <aside className="text-[12.5px]">
              <SidebarSection title="Repository">
                <span className="font-mono text-[12px] text-foreground">
                  {issue.repo}
                </span>
              </SidebarSection>
              <SidebarSection title="Status">
                <StateBadge item={issue} />
              </SidebarSection>
              <SidebarSection title="Assignees">
                {issue.assignees.length === 0 ? (
                  <None />
                ) : (
                  <div className="space-y-1.5">
                    {issue.assignees.map((a) => (
                      <div
                        key={a.login}
                        className="flex items-center gap-2 text-foreground"
                      >
                        <Avatar person={a} size={18} ring={false} />
                        {a.login}
                      </div>
                    ))}
                  </div>
                )}
              </SidebarSection>
              <SidebarSection title="Labels">
                {issue.labels.length === 0 ? (
                  <None />
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {issue.labels.map((l) => (
                      <LabelChip key={l.name} label={l} />
                    ))}
                  </div>
                )}
              </SidebarSection>
              {/* Filled by Start → (an agent Session working this issue). */}
              <SidebarSection title="Linked work">
                <None />
              </SidebarSection>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
