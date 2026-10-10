import { Panel, PanelGroup } from 'react-resizable-panels';
import { MessageSquare, TerminalSquare } from 'lucide-react';
import ResizeHandle from '../ResizeHandle';
import Terminal from '../Terminal';
import { ChatView } from './ChatView';
import {
  getViewMode,
  subscribe,
  getReturnToChat,
  setViewMode as setViewModeGlobal,
  setReturnToChat,
} from '../../lib/chatView';
import { useEffect, useRef, useState } from 'react';

export default function SplitLayout({
  rootId,
  path = '',
  tree,
  focusedId,
  rootPath,
  onOpenFile,
  onOpenLink,
  onExited,
  onRestart,
  onResume,
  onFocusPane,
  onBlurPane,
  onClosePane,
  onHandoff,
  sessionsById = {},
}) {
  const [viewMode, setViewMode] = useState(
    tree.leaf ? getViewMode(tree.leaf) : 'terminal'
  );

  const sessionState = sessionsById[tree?.leaf]?.state;
  const previousState = useRef(sessionState);

  useEffect(() => {
    if (!tree.leaf) return;
    if (previousState.current === 'needs-input' && sessionState !== 'needs-input') {
      if (getReturnToChat(tree.leaf)) {
        setViewModeGlobal(tree.leaf, 'chat');
        setReturnToChat(tree.leaf, false);
      }
    }
    previousState.current = sessionState;
  }, [sessionState, tree.leaf]);

  useEffect(() => {
    if (!tree.leaf) return;
    return subscribe(() => {
      setViewMode(getViewMode(tree.leaf));
    });
  }, [tree.leaf]);

  // A drag fires onLayout on every frame; the main process only needs the
  // ratio it settles on.
  const saveTimer = useRef(null);
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  const handleLayout = (sizes) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      window.electronAPI.setPaneRatio(rootId, path, sizes[0]);
    }, 500);
  };

  if (tree.leaf) {
    // `path` is empty only for an unsplit tab: no border, no close button.
    const split = path !== '';
    const isFocused = tree.leaf === focusedId;
    // The view toggle lives in whichever surface is showing — the terminal's
    // toolbar or the chat header — so it never covers either one's buttons.
    const viewToggle = sessionsById[tree.leaf]?.chat ? (
      <button
        title={
          viewMode === 'chat'
            ? 'Switch to Terminal View (⌘⇧C)'
            : 'Switch to Chat View (⌘⇧C)'
        }
        aria-label={
          viewMode === 'chat' ? 'Switch to terminal view' : 'Switch to chat view'
        }
        onClick={() =>
          setViewModeGlobal(tree.leaf, viewMode === 'chat' ? 'terminal' : 'chat')
        }
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {viewMode === 'chat' ? <TerminalSquare size={14} /> : <MessageSquare size={14} />}
      </button>
    ) : null;

    return (
      <div
        className={`relative h-full w-full ${
          split && isFocused
            ? 'z-10 ring-1 ring-highlight'
            : 'z-0 ring-1 ring-transparent'
        }`}
        onClickCapture={() => onFocusPane?.(tree.leaf)}
      >
        <div className={viewMode === 'chat' ? 'hidden' : 'h-full w-full'}>
          <Terminal
            sessionId={tree.leaf}
            rootPath={rootPath}
            onOpenFile={onOpenFile}
            onOpenLink={onOpenLink}
            onExited={() => onExited(tree.leaf)}
            onRestart={() => onRestart(tree.leaf)}
            onClosePane={split ? () => onClosePane(tree.leaf) : undefined}
            onFocus={() => onFocusPane?.(tree.leaf)}
            onBlur={() => onBlurPane?.()}
            isFocused={isFocused && viewMode !== 'chat'}
            isAgent={sessionsById[tree.leaf]?.isAgent}
            onHandoff={onHandoff}
            actions={viewToggle}
          />
        </div>
        {viewMode === 'chat' && (
          <ChatView
            sessionId={tree.leaf}
            onRestart={() => onRestart?.(tree.leaf)}
            onResume={() => onResume?.(tree.leaf)}
            headerActions={viewToggle}
          />
        )}
      </div>
    );
  }

  const direction = tree.dir === 'down' ? 'vertical' : 'horizontal';
  const child = (key, node) => (
    <SplitLayout
      rootId={rootId}
      path={path + key}
      tree={node}
      focusedId={focusedId}
      rootPath={rootPath}
      onOpenFile={onOpenFile}
      onOpenLink={onOpenLink}
      onExited={onExited}
      onRestart={onRestart}
      onResume={onResume}
      onFocusPane={onFocusPane}
      onBlurPane={onBlurPane}
      onClosePane={onClosePane}
      onHandoff={onHandoff}
      sessionsById={sessionsById}
    />
  );

  return (
    <PanelGroup direction={direction} onLayout={handleLayout} autoSaveId={null}>
      <Panel defaultSize={tree.ratio || 50} minSize={10}>
        {child('a', tree.a)}
      </Panel>
      <ResizeHandle direction={direction} />
      <Panel minSize={10}>{child('b', tree.b)}</Panel>
    </PanelGroup>
  );
}
