import { Plus, X, Settings2, Globe, PanelRight, GitCompare } from 'lucide-react';
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
  setSettingsOpen,
  setBrowserMenu,
  toggleExplorer,
  sitePath,
  explorerCollapsed,
  controlsInset,
  onTabContextMenu,
}) {
  return (
    <div
      className="drag-strip flex items-center gap-1 px-2 h-10 flex-shrink-0 overflow-x-auto"
      style={controlsInset ? { paddingLeft: controlsInset } : undefined}
    >
      {tabs.map((tab) => {
        const isActive = !showingFile && tab.sessionId === activeTab;
        return (
          <div
            key={tab.sessionId}
            onClick={() => selectSession(tab.sessionId)}
            onContextMenu={(e) => onTabContextMenu(e, tab.sessionId, 'session')}
            title={handoffTooltip(tab, tabs)}
            className={`group flex items-center gap-1.5 pl-2.5 pr-1.5 h-7 rounded-lg text-[12.5px] cursor-pointer whitespace-nowrap ${
              isActive
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            <ProviderIcon
              agentId={tab.agentId}
              brand
              size={13}
              className="flex-shrink-0"
            />
            <span className="truncate max-w-[140px]">{sessionTitle(tab, tabs)}</span>
            {(() => {
              const panes = tab.layout ? countLeaves(tab.layout) : 1;
              if (panes > 1) {
                return (
                  <span className="ml-0.5 rounded-[4px] bg-border/50 px-1 py-0.5 text-[10px] font-medium tabular-nums leading-none text-muted-foreground">
                    {panes}
                  </span>
                );
              }
              return null;
            })()}
            <Tooltip label="Close session">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.sessionId);
                }}
                aria-label="Close session"
                className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
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
            className={`group flex items-center gap-1.5 pl-2.5 pr-1.5 h-7 rounded-lg text-[12.5px] cursor-pointer whitespace-nowrap ${
              isActive
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            {isBrowser ? (
              <Favicon src={browserState[f.key]?.favicon} />
            ) : (
              <FileGlyph name={f.name} size={13} className="flex-shrink-0" />
            )}
            <span className="truncate max-w-[140px]">
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
                className={`p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground ${
                  isDirty ? 'hidden group-hover:block' : ''
                }`}
              >
                <X size={12} />
              </button>
            </Tooltip>
          </div>
        );
      })}

      <Tooltip label="New session">
        <button
          onClick={openAddMenu}
          disabled={detectedCount === 0}
          aria-label="New session"
          className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
        >
          <Plus size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Launch settings">
        <button
          onClick={() => setSettingsOpen(true)}
          disabled={detectedCount === 0}
          aria-label="Launch settings"
          className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
        >
          <Settings2 size={15} />
        </button>
      </Tooltip>
      <div className="drag-region flex-1 self-stretch" />
      <Tooltip label="Open browser">
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setBrowserMenu((m) => (m ? null : { x: r.right - 220, y: r.bottom + 4 }));
          }}
          aria-label="Open browser"
          className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          <Globe size={15} />
        </button>
      </Tooltip>
      {sitePath && (
        <Tooltip label="Toggle sidebar" keys={['⌘', '⇧', 'E']}>
          <button
            onClick={toggleExplorer}
            aria-label="Toggle sidebar"
            aria-pressed={!explorerCollapsed}
            className={`flex-shrink-0 p-1 rounded-md hover:text-foreground hover:bg-accent ${
              explorerCollapsed ? 'text-muted-foreground' : 'text-foreground'
            }`}
          >
            <PanelRight size={15} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
