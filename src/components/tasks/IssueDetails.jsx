import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  CircleDot,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  X,
} from 'lucide-react';
import { Tooltip } from '../ui';
import { useOpenLink } from '../../lib/useOpenLink';
import { sessionsFor, timeAgo } from '../../lib/tasks';
import { Avatar, LabelChip, StartButton, StateBadge } from './parts';
import { CommentCard, None, SidebarSection, TimelineEvent } from './timeline';
import { ProviderIcon } from '../providerIcons';
import { MarkdownEditor } from './markdown';
import { MultiPicker, StatusMenu } from './pickers';
import { useIssueMutation } from './useIssueMutation';

// One issue inside Tasks: header, the description as GitHub-flavoured
// markdown, the timeline of comments and key events, and a read-only sidebar.
// The data is `services/github.cjs` getIssue — the issue plus a normalised
// timeline — fetched on open and again on ↻.

// A sidebar heading that doubles as the picker's anchor, GitHub-style.
function EditableSection({ title, onEdit, busy, children }) {
  return (
    <SidebarSection
      title={
        <button
          className="flex w-full items-center justify-between hover:text-foreground"
          onClick={(e) => onEdit(e.currentTarget)}
        >
          {title}
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={11} />}
        </button>
      }
    >
      {children}
    </SidebarSection>
  );
}

export default function IssueDetails({
  repo,
  number,
  siteId,
  onBack,
  onChanged,
  linked,
  onStart,
  onOpenSession,
}) {
  const openLink = useOpenLink();
  const [data, setData] = useState(null); // { issue, timeline, truncated } | { error }
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const mutation = useIssueMutation();
  const [titleDraft, setTitleDraft] = useState(null); // string while editing
  const [bodyDraft, setBodyDraft] = useState(null);
  const [comment, setComment] = useState('');
  const [popover, setPopover] = useState(null); // { kind, anchor }

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
  const ref = { repo, number };

  // A write landed: show the issue GitHub sent back at once, then refetch so
  // the timeline gains its event, and let the list know.
  const landed = (res) => {
    if (res?.issue) setData((d) => (d?.issue ? { ...d, issue: res.issue } : d));
    load({ force: true });
    onChanged?.();
  };

  const saveTitle = async () => {
    if (titleDraft.trim() === issue.title) return setTitleDraft(null);
    const res = await mutation.run('tasksIssueEdit', { ...ref, title: titleDraft });
    if (res) {
      setTitleDraft(null);
      landed(res);
    }
  };

  const saveBody = async () => {
    const res = await mutation.run('tasksIssueEdit', { ...ref, body: bodyDraft });
    if (res) {
      setBodyDraft(null);
      landed(res);
    }
  };

  const setState = async (choice) => {
    const res = await mutation.run('tasksIssueState', { ...ref, ...choice });
    if (res) landed(res);
  };

  // Comment, optionally followed by a close or reopen. The comment posts
  // first, so a failed state change never loses it.
  const submitComment = async (then) => {
    if (comment.trim()) {
      const res = await mutation.run('tasksIssueComment', { ...ref, body: comment });
      if (!res) return;
      setComment('');
    }
    if (then) {
      const res = await mutation.run('tasksIssueState', { ...ref, ...then });
      if (!res) return load({ force: true });
      return landed(res);
    }
    landed(null);
  };

  const applyPicker = async (kind, keys) => {
    const res =
      kind === 'labels'
        ? await mutation.run('tasksIssueLabels', { ...ref, labels: keys })
        : await mutation.run('tasksIssueAssignees', { ...ref, assignees: keys });
    if (res) landed(res);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(issue.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — Open on GitHub still works
    }
  };

  const open = issue?.state === 'open';
  const busy = mutation.busy;

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
            <StartButton
              size="md"
              sessions={sessionsFor(linked, issue)}
              onStart={() => onStart(issue)}
              onOpenSession={onOpenSession}
            />
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
          {titleDraft !== null ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveTitle();
              }}
            >
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setTitleDraft(null)}
                aria-label="Title"
                className="form-input flex-1 !text-[15px]"
              />
              <button className="btn btn-primary" disabled={!!busy}>
                Save
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setTitleDraft(null)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="group flex items-start gap-2">
              <h1 className="flex-1 text-[20px] font-semibold text-foreground leading-snug">
                {issue.title}{' '}
                <span className="font-normal text-muted-foreground">#{issue.number}</span>
              </h1>
              <Tooltip label="Edit title">
                <button
                  className="btn btn-ghost !px-2 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label="Edit title"
                  onClick={() => setTitleDraft(issue.title)}
                >
                  <Pencil size={13} />
                </button>
              </Tooltip>
            </div>
          )}
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

          {mutation.error && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
              <AlertTriangle size={13} />
              <span className="flex-1">{mutation.error}</span>
              <button
                aria-label="Dismiss"
                className="hover:text-foreground"
                onClick={mutation.clearError}
              >
                <X size={13} />
              </button>
            </div>
          )}

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
                action={
                  bodyDraft === null && (
                    <button
                      className="hover:text-foreground"
                      onClick={() => setBodyDraft(issue.body)}
                    >
                      Edit
                    </button>
                  )
                }
              >
                {bodyDraft !== null && (
                  <div className="space-y-2">
                    <MarkdownEditor
                      value={bodyDraft}
                      onChange={setBodyDraft}
                      onLink={onLink}
                      onSubmit={saveBody}
                      rows={10}
                      autoFocus
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        className="btn btn-secondary"
                        onClick={() => setBodyDraft(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={saveBody}
                        disabled={!!busy}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </CommentCard>
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

              <div className="pt-2 border-t border-border space-y-2">
                <MarkdownEditor
                  value={comment}
                  onChange={setComment}
                  onLink={onLink}
                  onSubmit={() => comment.trim() && submitComment()}
                  placeholder="Leave a comment — markdown, ⌘↩ to send"
                />
                <div className="flex justify-end gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={!!busy}
                    onClick={() =>
                      submitComment(
                        open
                          ? { state: 'closed', reason: 'completed' }
                          : { state: 'open' }
                      )
                    }
                  >
                    {open ? <CheckCircle size={13} /> : <CircleDot size={13} />}
                    {open
                      ? comment.trim()
                        ? 'Close with comment'
                        : 'Close issue'
                      : comment.trim()
                        ? 'Reopen with comment'
                        : 'Reopen issue'}
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={!!busy || !comment.trim()}
                    onClick={() => submitComment()}
                  >
                    {busy === 'tasksIssueComment' && (
                      <Loader2 size={13} className="animate-spin" />
                    )}
                    Comment
                  </button>
                </div>
              </div>
            </div>

            <aside className="text-[12.5px]">
              <SidebarSection title="Repository">
                <span className="font-mono text-[12px] text-foreground">
                  {issue.repo}
                </span>
              </SidebarSection>
              <EditableSection
                title="Status"
                busy={busy === 'tasksIssueState'}
                onEdit={(anchor) => setPopover({ kind: 'status', anchor })}
              >
                <StateBadge item={issue} />
              </EditableSection>
              <EditableSection
                title="Assignees"
                busy={busy === 'tasksIssueAssignees'}
                onEdit={(anchor) => setPopover({ kind: 'assignees', anchor })}
              >
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
              </EditableSection>
              <EditableSection
                title="Labels"
                busy={busy === 'tasksIssueLabels'}
                onEdit={(anchor) => setPopover({ kind: 'labels', anchor })}
              >
                {issue.labels.length === 0 ? (
                  <None />
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {issue.labels.map((l) => (
                      <LabelChip key={l.name} label={l} />
                    ))}
                  </div>
                )}
              </EditableSection>
              {/* Live agent Sessions Start → launched for this issue. */}
              <SidebarSection title="Linked work">
                {sessionsFor(linked, issue).length === 0 ? (
                  <None />
                ) : (
                  <div className="space-y-1">
                    {sessionsFor(linked, issue).map((s) => (
                      <button
                        key={s.sessionId}
                        onClick={() => onOpenSession(s)}
                        className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-foreground hover:bg-accent"
                      >
                        <ProviderIcon agentId={s.agentId} brand size={13} />
                        <span className="truncate">{s.title || s.agentName}</span>
                      </button>
                    ))}
                  </div>
                )}
              </SidebarSection>
            </aside>
          </div>

          {popover?.kind === 'status' && (
            <StatusMenu
              anchor={popover.anchor}
              item={issue}
              onPick={setState}
              onClose={() => setPopover(null)}
            />
          )}
          {(popover?.kind === 'assignees' || popover?.kind === 'labels') && (
            <MultiPicker
              kind={popover.kind}
              repo={repo}
              anchor={popover.anchor}
              selected={
                popover.kind === 'labels'
                  ? issue.labels.map((l) => l.name)
                  : issue.assignees.map((a) => a.login)
              }
              onApply={(keys) => applyPicker(popover.kind, keys)}
              onClose={() => setPopover(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
