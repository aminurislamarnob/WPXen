import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Embedded terminal pane (Q4, revised: inline in the main window, Superset-style).
// Attaches to the main-process Session for `siteId`, replays the ring buffer,
// then streams live. Fills its parent, which sets the height.
export default function Terminal({ siteId, agentId, onExited }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
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
    termRef.current = term;

    const api = window.electronAPI;
    const onData = term.onData((data) => api.terminalInput(siteId, data));

    api.on('terminal-replay', (msg) => {
      if (msg.siteId && msg.siteId !== siteId) return;
      if (msg.data) term.write(msg.data);
      if (msg.exited) setExit({ code: null });
      fit.fit();
      api.terminalResize(siteId, term.cols, term.rows);
    });
    api.on('terminal-data', (msg) => {
      if (!msg.siteId || msg.siteId === siteId) term.write(msg.data);
    });
    api.on('terminal-exit', (msg) => {
      if (!msg.siteId || msg.siteId === siteId) setExit({ code: msg.code });
    });

    // Attach: main binds this window to the Session and replays the buffer.
    api.terminalReady(siteId);
    term.focus();

    const onResize = () => {
      fit.fit();
      api.terminalResize(siteId, term.cols, term.rows);
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
  }, [siteId]);

  const relaunch = async () => {
    const res = await window.electronAPI.launchAgent(siteId, agentId);
    if (res?.error) return;
    termRef.current?.reset();
    setExit(null);
    window.electronAPI.terminalReady(siteId);
    termRef.current?.focus();
  };

  return (
    <div className="relative h-full w-full rounded-xl overflow-hidden bg-[#1c1c1e]">
      <div ref={hostRef} className="h-full w-full p-2" />
      {exit && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="panel rounded-2xl p-6 w-[320px] text-center">
            <p className="text-sm font-medium text-gray-900">Session ended</p>
            <p className="mt-1 text-xs text-gray-500">
              {exit.code == null
                ? 'The agent is no longer running.'
                : `The agent exited (code ${exit.code}).`}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              {agentId && (
                <button className="btn btn-primary" onClick={relaunch}>
                  Relaunch
                </button>
              )}
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
