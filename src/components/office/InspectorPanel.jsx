import { useEffect, useRef } from 'react';
import { GitBranch } from 'lucide-react';
import { SectionLabel } from '../ui';
import { inspectorView } from '../../lib/office/hud.js';
import { teamColor } from '../../lib/office/scene/theme.js';
import { PanelHeader, TeamSwatch } from './PanelChrome.jsx';
import { StateBadge } from './StateBadge.jsx';

// The inspector for the focused agent: who it is, what it's doing, what it
// was asked, its interns and its recent feed — re-derived from every snapshot
// (lib/office/hud.js inspectorView), so it updates live.

const FEED_TONE = {
  error: 'text-status-error',
  tool_use: 'text-highlight',
};

const EXCERPT_CLASS = {
  error: 'text-status-error',
  tool_result: 'font-mono text-muted-foreground',
};

export function InspectorPanel({
  session,
  focusedSubagentId,
  onClose,
  onFocusSession,
  onFocusSubagent,
}) {
  const view = inspectorView(session, focusedSubagentId);
  const feedEnd = useRef(null);
  const newest = view.feed.at(-1)?.id;

  // Follow the feed as it grows, like a log tail.
  useEffect(() => {
    feedEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [newest]);

  return (
    <>
      <PanelHeader
        closeLabel="Close inspector"
        onClose={onClose}
        eyebrow={
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <TeamSwatch color={teamColor(view.projectKey)} />
            <span className="truncate">{view.projectKey}</span>
            {view.gitBranch && (
              <span className="inline-flex items-center gap-1 min-w-0 font-mono text-[11px]">
                <GitBranch size={11} className="flex-shrink-0" />
                <span className="truncate">{view.gitBranch}</span>
              </span>
            )}
          </div>
        }
        title={
          <>
            <button
              onClick={onFocusSession}
              title="Focus this agent"
              className="block max-w-full text-left text-[14px] font-semibold text-foreground truncate mt-0.5 hover:underline"
            >
              {view.title}
            </button>
            {view.name && (
              <p className="text-[11px] text-muted-foreground truncate font-mono">
                {view.name}
              </p>
            )}
          </>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-4">
        <div className="sheet-well space-y-1.5">
          {view.intern ? (
            <>
              <p className="text-[11px] text-muted-foreground">
                Intern · {view.intern.agentType}
              </p>
              <StateBadge badge={view.intern.badge} />
              {view.intern.description && (
                <p className="text-xs text-foreground">{view.intern.description}</p>
              )}
            </>
          ) : (
            <StateBadge badge={view.badge} />
          )}
        </div>

        {view.lastPrompt && (
          <section>
            <SectionLabel>Last prompt</SectionLabel>
            <blockquote className="border-l-2 border-border pl-3 text-xs text-foreground whitespace-pre-wrap break-words line-clamp-6">
              {view.lastPrompt}
            </blockquote>
          </section>
        )}

        {view.interns.length > 0 && (
          <section>
            <SectionLabel>Interns</SectionLabel>
            <ul>
              {view.interns.map((sub) => (
                <li key={sub.subagentId}>
                  <button
                    className={`panel-item items-start ${
                      sub.subagentId === focusedSubagentId ? 'bg-accent' : ''
                    }`}
                    aria-current={sub.subagentId === focusedSubagentId || undefined}
                    onClick={() => onFocusSubagent(sub.subagentId)}
                  >
                    <span className="flex-1 min-w-0 text-left">
                      <span className="block truncate font-medium">{sub.agentType}</span>
                      {sub.description && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {sub.description}
                        </span>
                      )}
                    </span>
                    <StateBadge badge={sub.badge} compact />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionLabel>Live feed</SectionLabel>
          {view.feed.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">No events yet.</p>
          ) : (
            <ol className="space-y-2 px-1">
              {view.feed.map((event) => (
                <li key={event.id} className="min-w-0">
                  <span
                    className={`block text-[10.5px] font-semibold uppercase tracking-wide ${
                      FEED_TONE[event.type] ?? 'text-muted-foreground'
                    }`}
                  >
                    {event.label}
                  </span>
                  <span
                    className={`block text-xs break-words line-clamp-3 ${
                      EXCERPT_CLASS[event.type] ?? 'text-foreground'
                    }`}
                  >
                    {event.excerpt}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <div ref={feedEnd} />
        </section>
      </div>
    </>
  );
}
