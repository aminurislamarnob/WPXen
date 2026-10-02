import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle,
  CircleDot,
  Copy,
  ExternalLink,
  FileText,
  ListChecks,
  MessageSquare,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { SegmentedTabs, Tooltip } from '../ui';
import DiffView from '../DiffView';
import { useOpenLink } from '../../lib/useOpenLink';
import { sessionsFor, timeAgo } from '../../lib/tasks';
import { patchToSides } from '../../lib/patch';
import { Avatar, LabelChip, StartButton } from './parts';
import { ProviderIcon } from '../providerIcons';
import { CommentCard, None, SidebarSection, TimelineEvent } from './timeline';
import { MergeBadge, pullIcon } from './PullTable';

// One PR inside Tasks, read-only: Conversation (description, comments,
// reviews with their verdicts), Files (each changed file, with its diff in
// the same view Changes uses) and Checks (each run with its status, duration
// and logs). Files and Checks load the first time their tab opens.

const TABS = [
  { value: 'conversation', label: 'Conversation', icon: MessageSquare },
  { value: 'files', label: 'Files', icon: FileText },
  { value: 'checks', label: 'Checks', icon: ListChecks },
];

// Loads `fetcher()` once `enabled`, again on `reloadKey` changes.
function useLazy(fetcher, enabled, reloadKey) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetcher().then((res) => !cancelled && setState(res));
    return () => {
      cancelled = true;
    };
    // `fetcher` closes over what `reloadKey` stands for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reloadKey]);
  return state;
}

function ErrorCard({ error, onRetry }) {
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm px-6 py-10 text-center">
      <p className="text-[14px] font-medium text-foreground">Couldn’t load this</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{error.message}</p>
      <button className="btn btn-secondary mt-4" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function Loading() {
  return (
    <div className="px-4 py-12 text-center text-[13px] text-muted-foreground">
      Loading…
    </div>
  );
}

const STATUS_LETTER = {
  added: ['A', 'text-status-running'],
  removed: ['D', 'text-destructive'],
  renamed: ['R', 'text-highlight'],
  copied: ['C', 'text-highlight'],
};

function FilesTab({ data, onRetry }) {
  const [open, setOpen] = useState(null); // path
  const files = data?.files || [];
  const current = files.find((f) => f.path === open) || null;
  const sides = useMemo(
    () => (current?.patch ? patchToSides(current.patch) : null),
    [current]
  );

  if (!data) return <Loading />;
  if (data.error) return <ErrorCard error={data.error} onRetry={onRetry} />;
  if (files.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No changed files.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        {files.map((f) => {
          const [letter, tone] = STATUS_LETTER[f.status] || ['M', 'text-status-warning'];
          return (
            <button
              key={f.path}
              onClick={() => setOpen(open === f.path ? null : f.path)}
              className={`flex w-full items-center gap-2.5 px-4 py-2 text-left border-b border-border last:border-b-0 hover:bg-accent/50 ${
                open === f.path ? 'bg-accent/60' : ''
              }`}
            >
              <span className={`w-3 font-mono text-[11px] font-semibold ${tone}`}>
                {letter}
              </span>
              <span className="flex-1 min-w-0 truncate font-mono text-[12px] text-foreground">
                {f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
              </span>
              <span className="font-mono text-[11.5px] tabular-nums text-status-running">
                +{f.additions}
              </span>
              <span className="font-mono text-[11.5px] tabular-nums text-destructive">
                −{f.deletions}
              </span>
            </button>
          );
        })}
      </div>
      {data.truncated && (
        <p className="text-[12px] text-muted-foreground">
          Showing the first 100 files — the rest are on GitHub.
        </p>
      )}
      {current && (
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 h-9 flex items-center border-b border-border bg-tertiary font-mono text-[12px] text-foreground">
            {current.path}
          </div>
          {sides ? (
            <div className="h-[520px] flex">
              <DiffView
                name={current.path.split('/').pop()}
                original={sides.original}
                modified={sides.modified}
                className="flex-1 min-w-0"
              />
            </div>
          ) : (
            <p className="px-4 py-6 text-[12.5px] text-muted-foreground">
              No diff to show — the file is binary, or too large for GitHub to diff.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const CHECK_ICON = {
  passing: [CheckCircle, 'text-status-running'],
  failing: [XCircle, 'text-destructive'],
  pending: [CircleDot, 'text-status-warning'],
};

function ChecksTab({ data, onRetry, onLink }) {
  if (!data) return <Loading />;
  if (data.error) return <ErrorCard error={data.error} onRetry={onRetry} />;
  if (data.checks.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">No checks on the head commit.</p>
    );
  }
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      {data.checks.map((c) => {
        const [Icon, tone] = CHECK_ICON[c.state] || CHECK_ICON.pending;
        return (
          <div
            key={c.id}
            className="flex items-center gap-2.5 px-4 py-2 border-b border-border last:border-b-0"
          >
            <Icon size={14} className={tone} strokeWidth={2.2} />
            <span className="flex-1 min-w-0 truncate text-[12.5px] text-foreground">
              {c.name}
              {c.description && (
                <span className="text-muted-foreground"> — {c.description}</span>
              )}
            </span>
            <span className="text-[11.5px] text-muted-foreground">
              {String(c.conclusion || '').replace(/_/g, ' ')}
            </span>
            <span className="w-14 text-right text-[11.5px] tabular-nums text-muted-foreground">
              {formatDuration(c.durationMs)}
            </span>
            {c.url ? (
              <button
                className="text-[12px] text-highlight hover:underline"
                onClick={() => onLink(c.url)}
              >
                Logs
              </button>
            ) : (
              <span className="w-[30px]" />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PullDetails({
  repo,
  number,
  siteId,
  onBack,
  linked,
  onStart,
  onOpenSession,
}) {
  const openLink = useOpenLink();
  const onLink = (url) => openLink(url, siteId);
  const [tab, setTab] = useState('conversation');
  const [data, setData] = useState(null); // { pull, timeline, truncated } | { error }
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    async ({ force = false } = {}) => {
      setLoading(true);
      try {
        setData(await window.electronAPI.tasksPull({ repo, number, force }));
      } finally {
        setLoading(false);
      }
    },
    [repo, number]
  );
  useEffect(() => {
    load();
  }, [load]);

  const pull = data?.pull;
  const files = useLazy(
    () => window.electronAPI.tasksPullFiles({ repo, number, force: reload > 0 }),
    tab === 'files' && !!pull,
    reload
  );
  const checks = useLazy(
    () =>
      window.electronAPI.tasksPullChecks({ repo, sha: pull?.headSha, force: reload > 0 }),
    tab === 'checks' && !!pull?.headSha,
    `${reload}:${pull?.headSha}`
  );

  const refresh = () => {
    load({ force: true });
    setReload((n) => n + 1);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(pull.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — Open on GitHub still works
    }
  };

  const now = Date.now();
  const { Icon, tone } = pull ? pullIcon(pull) : {};

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <button className="btn btn-ghost !px-2" onClick={onBack}>
          <ArrowLeft size={14} />
          PRs
        </button>
        <span className="font-mono text-[12px] text-muted-foreground">
          {repo} #{number}
        </span>
        <div className="flex-1" />
        <Tooltip label="Refresh">
          <button
            className="btn btn-secondary !px-2"
            aria-label="Refresh"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </Tooltip>
        {pull && (
          <>
            {pull.state === 'open' && (
              <StartButton
                size="md"
                sessions={sessionsFor(linked, pull)}
                onStart={() => onStart(pull)}
                onOpenSession={onOpenSession}
              />
            )}
            <button className="btn btn-secondary" onClick={copyLink}>
              <Copy size={13} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button className="btn btn-secondary" onClick={() => onLink(pull.url)}>
              <ExternalLink size={13} />
              Open on GitHub
            </button>
          </>
        )}
      </div>

      {data?.error ? (
        <ErrorCard error={data.error} onRetry={() => load({ force: true })} />
      ) : !pull ? (
        <Loading />
      ) : (
        <>
          <h1 className="text-[20px] font-semibold text-foreground leading-snug">
            {pull.title}{' '}
            <span className="font-normal text-muted-foreground">#{pull.number}</span>
          </h1>
          <div className="mt-2 mb-4 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Icon size={14} className={tone} />
              {pull.merged
                ? 'Merged'
                : pull.state === 'closed'
                  ? 'Closed'
                  : pull.draft
                    ? 'Draft'
                    : 'Open'}
            </span>
            <span>
              <span className="font-medium text-foreground">
                {pull.author || 'ghost'}
              </span>{' '}
              wants to merge {pull.commits} {pull.commits === 1 ? 'commit' : 'commits'}{' '}
              into <code className="font-mono text-foreground">{pull.baseRef}</code> from{' '}
              <code className="font-mono text-foreground">{pull.headRef}</code> · updated{' '}
              {timeAgo(pull.updatedAt, now)}
            </span>
          </div>

          <SegmentedTabs
            tabs={TABS.map((t) =>
              t.value === 'files' ? { ...t, label: `Files ${pull.changedFiles}` } : t
            )}
            value={tab}
            onChange={setTab}
            className="mb-4"
          />

          <div className="grid grid-cols-[1fr_220px] gap-6 items-start">
            <div className="min-w-0 space-y-4">
              {tab === 'conversation' && (
                <>
                  <CommentCard
                    author={{ login: pull.author }}
                    at={pull.createdAt}
                    body={pull.body}
                    url={pull.url}
                    onLink={onLink}
                    now={now}
                    empty="No description provided."
                  />
                  {data.timeline.map((event) => (
                    <TimelineEvent
                      key={event.id}
                      event={event}
                      now={now}
                      onLink={onLink}
                    />
                  ))}
                  {data.truncated && (
                    <p className="text-[12px] text-muted-foreground">
                      Older activity is on{' '}
                      <button
                        className="text-highlight hover:underline"
                        onClick={() => onLink(pull.url)}
                      >
                        GitHub
                      </button>
                      .
                    </p>
                  )}
                </>
              )}
              {tab === 'files' && <FilesTab data={files} onRetry={refresh} />}
              {tab === 'checks' && (
                <ChecksTab data={checks} onRetry={refresh} onLink={onLink} />
              )}
            </div>

            <aside className="text-[12.5px]">
              <SidebarSection title="Repository">
                <span className="font-mono text-[12px] text-foreground">{pull.repo}</span>
              </SidebarSection>
              <SidebarSection title="Merge">
                <MergeBadge merge={pull.merge} />
              </SidebarSection>
              <SidebarSection title="Changes">
                <span className="font-mono text-[12px]">
                  <span className="text-status-running">+{pull.additions}</span>{' '}
                  <span className="text-destructive">−{pull.deletions}</span>{' '}
                  <span className="text-muted-foreground">
                    in {pull.changedFiles} files
                  </span>
                </span>
              </SidebarSection>
              <SidebarSection title="Reviewers">
                {pull.reviewers.length === 0 ? (
                  <None />
                ) : (
                  <div className="space-y-1.5">
                    {pull.reviewers.map((r) => (
                      <div
                        key={r.login}
                        className="flex items-center gap-2 text-foreground"
                      >
                        <Avatar person={r} size={18} ring={false} />
                        {r.login}
                      </div>
                    ))}
                  </div>
                )}
              </SidebarSection>
              <SidebarSection title="Linked work">
                {sessionsFor(linked, pull).length === 0 ? (
                  <None />
                ) : (
                  <div className="space-y-1">
                    {sessionsFor(linked, pull).map((s) => (
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
              <SidebarSection title="Labels">
                {pull.labels.length === 0 ? (
                  <None />
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {pull.labels.map((l) => (
                      <LabelChip key={l.name} label={l} />
                    ))}
                  </div>
                )}
              </SidebarSection>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
