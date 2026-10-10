import { Panel, PanelGroup } from 'react-resizable-panels';
import ResizeHandle from '../ResizeHandle';
import Terminal from '../Terminal';
import { useEffect, useRef } from 'react';

export default function SplitLayout({
  rootId,
  path = '',
  tree,
  activeId,
  rootPath,
  onOpenFile,
  onOpenLink,
  onExited,
  onRestart,
}) {
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
    return (
      <Terminal
        sessionId={tree.leaf}
        rootPath={rootPath}
        onOpenFile={onOpenFile}
        onOpenLink={onOpenLink}
        onExited={() => onExited(tree.leaf)}
        onRestart={() => onRestart(tree.leaf)}
      />
    );
  }

  const direction = tree.dir === 'down' ? 'vertical' : 'horizontal';

  return (
    <PanelGroup direction={direction} onLayout={handleLayout} autoSaveId={null}>
      <Panel defaultSize={tree.ratio || 50} minSize={10}>
        <SplitLayout
          rootId={rootId}
          path={path + 'a'}
          tree={tree.a}
          activeId={activeId}
          rootPath={rootPath}
          onOpenFile={onOpenFile}
          onOpenLink={onOpenLink}
          onExited={onExited}
          onRestart={onRestart}
        />
      </Panel>
      <ResizeHandle direction={direction} />
      <Panel minSize={10}>
        <SplitLayout
          rootId={rootId}
          path={path + 'b'}
          tree={tree.b}
          activeId={activeId}
          rootPath={rootPath}
          onOpenFile={onOpenFile}
          onOpenLink={onOpenLink}
          onExited={onExited}
          onRestart={onRestart}
        />
      </Panel>
    </PanelGroup>
  );
}
