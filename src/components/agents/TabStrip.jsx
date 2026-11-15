import { Plus, X, Globe, PanelRight, GitCompare } from 'lucide-react';
import { ProviderIcon } from '../providerIcons';
import { Tooltip } from '../ui';
import { FileGlyph } from '../../lib/fileIcons';
import { Favicon } from '../browser/BrowserToolbar';
import { sessionTitle } from '../../lib/agentsList';

function countLeaves(tree) {
  if (!tree) return 1;
  if (tree.leaf) return 1;
  return countLeaves(tree.a) + countLeaves(tree.b);
}

// A handed-off Session names where it came from and the file it was given.
function handoffTooltip(tab, tabs) {
  if (!tab.handoffFrom) return undefined;
  const origin = tabs.find((t) => t.sessionId === tab.handoffFrom);
  const from = origin ? sessionTitle(origin, tabs) : 'an ended session';
  return `Handed off from ${from}\n${tab.handoffFile}`;
}

// A resumed Session names the Session whose transcript it continues.
function resumeTooltip(tab, tabs) {
  if (!tab.resumeFrom) return undefined;
  const origin = tabs.find((t) => t.sessionId === tab.resumeFrom);
  const from = origin ? sessionTitle(origin, tabs) : 'an ended session';
  return `Resumed from ${from}`;
}

function tabTooltip(tab, tabs) {
  return handoffTooltip(tab, tabs) || resumeTooltip(tab, tabs);
}

// The Agents screen's top bar, Orca-style: one 40px band split into bordered
// segments that line up with the columns below (activity bar, sidebar, this
// tab strip, the explorer). Tabs fill the bar's height with a hairline between
// them; the active one takes the content's background and opens into it. The
// panel toggle lives here only while the explorer is closed; when it is open
// the explorer's own header carries it (see ExplorerToggle).
const TAB =
  'group flex items-center gap-2 pl-3 pr-2 border-r border-border text-[12.5px] cursor-pointer whitespace-nowrap';
const tabTone = (active) =>
  active
    ? 'bg-background text-foreground'
    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50';
const closeTone = (active) =>
  `p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground ${
    active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
  }`;

/** Opens or closes the explorer; rendered in whichever segment is on screen. */
export function ExplorerToggle({ collapsed, onToggle }) {
  return (
    <Tooltip label="Toggle sidebar" keys={['⌘', '⇧', 'E']}>
      <button
        onClick={onToggle}
        aria-label="Toggle sidebar"
        aria-pressed={!collapsed}
        className={`flex-shrink-0 flex items-center justify-center size-7 rounded-md hover:text-foreground hover:bg-accent ${
          collapsed ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        <PanelRight size={15} />
      </button>
    </Tooltip>
  );
}

export default function TabStrip({
  tabs,
  openFiles,
  activeTab,
  activeKey,
  showingFile,
  selectSession,
  selectFile,
  closeTab,
  requestCloseFile,
  browserState,
  dirtyKeys,
  openAddMenu,
  detectedCount,
  setBrowserMenu,
  toggleExplorer,
  sitePath,
  explorerCollapsed,
  controlsInset,
  onTabContextMenu,
}) {
  return (
    <div className="relative h-10 flex-shrink-0 flex bg-tertiary">
      {/* The bar's bottom hairline; the active tab paints over it. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border" />
      <div
        className="drag-strip relative flex-1 min-w-0 flex items-stretch overflow-x-auto"
        style={{
          scrollbarWidth: 'none',
          ...(controlsInset ? { paddingLeft: controlsInset } : null),
        }}
      >
        {tabs.map((tab) => {
          const isActive = !showingFile && tab.sessionId === activeTab;
          const panes = tab.layout ? countLeaves(tab.layout) : 1;
          return (
            <div
              key={tab.sessionId}
              onClick={() => selectSession(tab.sessionId)}
              onContextMenu={(e) => onTabContextMenu(e, tab.sessionId, 'session')}
              title={tabTooltip(tab, tabs)}
              className={`${TAB} ${tabTone(isActive)}`}
            >
              <ProviderIcon
                agentId={tab.agentId}
                brand
                size={13}
                className="flex-shrink-0"
              />
              <span className="truncate max-w-[220px]">{sessionTitle(tab, tabs)}</span>
              {panes > 1 && (
                <span className="rounded-[4px] bg-border/50 px-1 py-0.5 text-[10px] font-medium tabular-nums leading-none text-muted-foreground">
                  {panes}
                </span>
              )}
              <Tooltip label="Close session">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.sessionId);
                  }}
                  aria-label="Close session"
                  className={closeTone(isActive)}
                >
                  <X size={12} />
                </button>
              </Tooltip>
            </div>
          );
        })}

        {openFiles.map((f) => {
          const isActive = showingFile && f.key === activeKey;
          const isBrowser = f.kind === 'browser';
          const isDiff = f.kind === 'diff';
          const isDirty = dirtyKeys.includes(f.key);
          return (
            <div
              key={f.key}
              onClick={() => selectFile(f.key)}
              onContextMenu={(e) => onTabContextMenu(e, f.key, f.kind)}
              title={
                isBrowser
                  ? browserState[f.key]?.url || 'Browser'
                  : isDiff
                    ? `${f.rel} — diff (${f.source})`
                    : f.path
              }
              className={`${TAB} ${tabTone(isActive)}`}
            >
              {isBrowser ? (
                <Favicon src={browserState[f.key]?.favicon} />
              ) : (
                <FileGlyph name={f.name} size={13} className="flex-shrink-0" />
              )}
              <span className="truncate max-w-[220px]">
                {isBrowser ? browserState[f.key]?.title || f.name : f.name}
              </span>
              {isDiff && (
                <GitCompare size={11} className="flex-shrink-0 text-muted-foreground" />
              )}
              {isDirty && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-highlight group-hover:hidden flex-shrink-0"
                  title="Unsaved changes"
                />
              )}
              <Tooltip label="Close tab">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    requestCloseFile(f.key);
                  }}
                  aria-label="Close tab"
                  className={
                    isDirty
                      ? 'hidden group-hover:block p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground'
                      : closeTone(isActive)
                  }
                >
                  <X size={12} />
                </button>
              </Tooltip>
            </div>
          );
        })}

        {/* Launch settings live in this menu ("Launch settings…"). */}
        <Tooltip label="New session">
          <button
            onClick={openAddMenu}
            disabled={detectedCount === 0}
            aria-label="New session"
            className="flex-shrink-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 disabled:opacity-40"
          >
            <Plus size={16} />
          </button>
        </Tooltip>
        <div className="drag-region flex-1 min-w-6" />
      </div>

      <div className="drag-strip relative flex items-center gap-1 px-2">
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setBrowserMenu((m) => (m ? null : { x: r.right - 220, y: r.bottom + 4 }));
          }}
          aria-label="Open browser"
          className="flex items-center gap-1.5 h-7 px-2 rounded-md text-[12.5px] text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          <Globe size={14} />
          Browser
        </button>
        {sitePath && explorerCollapsed && (
          <ExplorerToggle collapsed onToggle={toggleExplorer} />
        )}
      </div>
    </div>
  );
}
