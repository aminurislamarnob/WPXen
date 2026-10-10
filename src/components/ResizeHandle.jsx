import { PanelResizeHandle } from 'react-resizable-panels';
import { setDragPassthrough } from '../lib/browser/webviewCache';

// A thin vertical drag handle for horizontal PanelGroups. The visible line is
// 1px; the surrounding hit area is wider so it's easy to grab. Highlights on
// hover and while dragging.
//
// Dragging also has to punch through any in-app browser page in the group: a
// <webview> composites separately and eats the pointer stream, so the drag
// would stall the instant the cursor crossed onto it.
export default function ResizeHandle({ direction = 'horizontal' }) {
  const isVertical = direction === 'vertical';
  return (
    <PanelResizeHandle
      onDragging={setDragPassthrough}
      className={`group relative flex-shrink-0 bg-muted outline-none ${
        isVertical ? 'h-px' : 'w-px'
      }`}
    >
      <div
        className={`absolute z-10 ${
          isVertical
            ? 'inset-x-0 -top-1 -bottom-1 cursor-row-resize'
            : 'inset-y-0 -left-1 -right-1 cursor-col-resize'
        }`}
      />
      <div
        className={`absolute bg-highlight/10 opacity-0 transition-opacity group-hover:opacity-100 group-data-[resize-handle-state=drag]:opacity-100 ${
          isVertical ? 'inset-x-0 top-0 h-px' : 'inset-y-0 left-0 w-px'
        }`}
      />
    </PanelResizeHandle>
  );
}
