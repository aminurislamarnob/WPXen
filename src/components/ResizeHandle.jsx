import { PanelResizeHandle } from 'react-resizable-panels';

// A thin vertical drag handle for horizontal PanelGroups. The visible line is
// 1px; the surrounding hit area is wider so it's easy to grab. Highlights on
// hover and while dragging.
export default function ResizeHandle() {
  return (
    <PanelResizeHandle className="group relative w-px flex-shrink-0 bg-muted outline-none">
      <div className="absolute inset-y-0 -left-1 -right-1 z-10 cursor-col-resize" />
      <div className="absolute inset-y-0 left-0 w-px bg-highlight/10 opacity-0 transition-opacity group-hover:opacity-100 group-data-[resize-handle-state=drag]:opacity-100" />
    </PanelResizeHandle>
  );
}
