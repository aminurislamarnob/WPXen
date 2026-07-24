import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Embedded terminal pane bound to a single main-process Session (by sessionId).
// Replays the ring buffer on attach, then streams live. Fills its parent, which
// sets the height.
export default function Terminal({ sessionId, onExited }) {
  const hostRef = useRef(null);
  const [exit, setExit] = useState(null); // { code } once the Session ends

  useEffect(() => {
    const term = new XTerm({
      fontFamily:
        'SFMono-Regular, ui-monospace, Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: '#1c1c1e', foreground: '#e5e5e7' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const api = window.electronAPI;
    const onData = term.onData((data) => api.terminalInput(sessionId, data));

    api.on('terminal-replay', (msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.data) term.write(msg.data);
      if (msg.exited) setExit({ code: null });
      fit.fit();
      api.terminalResize(sessionId, term.cols, term.rows);
    });
    api.on('terminal-data', (msg) => {
      if (msg.sessionId === sessionId) term.write(msg.data);
    });
    api.on('terminal-exit', (msg) => {
      if (msg.sessionId === sessionId) setExit({ code: msg.code });
    });

    // Attach: main binds this window to the Session and replays the buffer.
    api.terminalReady(sessionId);
    term.focus();

    const onResize = () => {
      fit.fit();
      api.terminalResize(sessionId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(hostRef.current);

    return () => {
      onData.dispose();
      ro.disconnect();
      api.off('terminal-replay');
      api.off('terminal-data');
      api.off('terminal-exit');
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="relative h-full w-full rounded-xl overflow-hidden bg-[#1c1c1e]">
      <div ref={hostRef} className="h-full w-full p-2" />
      {exit && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="panel rounded-2xl p-6 w-[320px] text-center">
            <p className="text-sm font-medium text-gray-900">Session ended</p>
            <p className="mt-1 text-xs text-gray-500">
              {exit.code == null
                ? 'The shell is no longer running.'
                : `The shell exited (code ${exit.code}).`}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button className="btn btn-secondary" onClick={onExited}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
