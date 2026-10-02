import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle,
  CircleDot,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  Send,
  X,
} from 'lucide-react';
import { Tooltip } from '../ui';
import { useOpenLink } from '../../lib/useOpenLink';
import { sessionsFor, timeAgo } from '../../lib/tasks';
import { Avatar, LabelChip, StartButton, StateBadge } from './parts';
import { None, SidebarSection, TimelineEvent } from './timeline';
import { ProviderIcon } from '../providerIcons';
import { Markdown } from './markdown';
import MarkdownComposer from './MarkdownComposer';
import { DetailsSkeleton } from './skeletons';
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

  // Enter saves and the field then blurs, which saves too — one save only.
  const savingTitle = useRef(false);
  const saveTitle = async () => {
    if (titleDraft === null || savingTitle.current) return;
    const next = titleDraft.trim();
    // An empty or unchanged title just ends the edit, as in Orca.
    if (!next || next === issue.title) return setTitleDraft(null);
    savingTitle.current = true;
    try {
      const res = await mutation.run('tasksIssueEdit', { ...ref, title: next });
      if (res) {
        setTitleDraft(null);
        landed(res);
      }
    } finally {
      savingTitle.current = false;
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
        <DetailsSkeleton />
      ) : (
        <>
          {/* The title edits in place, as in Orca: click it, Enter or leaving
              the field saves, Escape cancels. */}
          {titleDraft !== null ? (
            <input
              autoFocus
              value={titleDraft}
              disabled={busy === 'tasksIssueEdit'}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveTitle();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setTitleDraft(null);
                }
              }}
              aria-label="Title"
              className="form-input w-full !h-9 !text-[18px] font-semibold"
            />
          ) : (
            <h1 className="text-[20px] font-semibold text-foreground leading-snug">
              <button
                type="button"
                title="Edit title"
                className="text-left hover:underline decoration-muted-foreground/50 underline-offset-4"
                onClick={() => setTitleDraft(issue.title)}
              >
                {issue.title}
              </button>{' '}
              <span className="font-normal text-muted-foreground">#{issue.number}</span>
            </h1>
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
              {/* The description card, Orca's: a pencil in its header swaps
                  the body for the editor, with Cancel / Save beside it. */}
              <div className="flex gap-3">
                <Avatar
                  person={{ login: issue.author, avatarUrl: issue.authorAvatar }}
                  size={28}
                  ring={false}
                />
                <div className="flex-1 min-w-0 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                  <div className="flex items-center gap-2 px-4 h-10 border-b border-border bg-tertiary text-[12px] text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {issue.author || 'ghost'}
                    </span>
                    <span>updated {timeAgo(issue.updatedAt, now)}</span>
                    {bodyDraft !== null ? (
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          className="btn btn-ghost !h-7 !px-2 !text-[12px]"
                          disabled={busy === 'tasksIssueEdit'}
                          onClick={() => setBodyDraft(null)}
                        >
                          <X size={13} />
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary !h-7 !px-2 !text-[12px]"
                          disabled={busy === 'tasksIssueEdit' || bodyDraft === issue.body}
                          onClick={saveBody}
                        >
                          {busy === 'tasksIssueEdit' ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Check size={13} />
                          )}
                          Save
                        </button>
                      </div>
                    ) : (
                      <Tooltip label="Edit description">
                        <button
                          type="button"
                          aria-label="Edit description"
                          className="ml-auto inline-flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
                          onClick={() => setBodyDraft(issue.body)}
                        >
                          <Pencil size={13} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  <div className="px-4 py-4">
                    {bodyDraft !== null ? (
                      <MarkdownComposer
                        value={bodyDraft}
                        onChange={setBodyDraft}
                        placeholder="Description"
                        disabled={busy === 'tasksIssueEdit'}
                        autoFocus
                        minHeightClassName="min-h-64"
                        onSubmit={saveBody}
                      />
                    ) : (
                      <Markdown
                        text={issue.body}
                        onLink={onLink}
                        empty="No description provided."
                      />
                    )}
                  </div>
                </div>
              </div>
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

              {/* Orca's comment box: the editor with a send button in its
                  corner; ⌘↩ sends too. Closing or reopening rides along. */}
              <div className="pt-2 border-t border-border">
                <div className="relative">
                  <MarkdownComposer
                    value={comment}
                    onChange={setComment}
                    placeholder="Add a comment…"
                    disabled={busy === 'tasksIssueComment'}
                    minHeightClassName="min-h-28 pb-14 pr-14"
                    onSubmit={() => comment.trim() && submitComment()}
                  />
                  <Tooltip label="Send comment">
                    <button
                      type="button"
                      aria-label="Send comment"
                      className="btn btn-primary !h-8 !w-8 !p-0 absolute bottom-3 right-3 shadow-sm"
                      disabled={!!busy || !comment.trim()}
                      onClick={() => submitComment()}
                    >
                      {busy === 'tasksIssueComment' ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <Send size={15} />
                      )}
                    </button>
                  </Tooltip>
                </div>
                <div className="mt-2 flex justify-end">
                  <button
                    className="btn btn-ghost !h-7 !px-2 !text-[12px]"
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
