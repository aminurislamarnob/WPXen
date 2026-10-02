import { useEffect, useState } from 'react';
import { CornerDownRight, Settings2 } from 'lucide-react';
import { ProviderIcon } from './providerIcons';

// The "new session" menu for one Site: every installed agent, each followed by
// its saved Launch Targets for that Site. Shared by the Agents pane's "+" and
// the Projects sidebar, so there is one launch menu in every place it appears.
//
// Rendered `fixed` at viewport coordinates (`anchor`) behind a click-away
// backdrop, so a scrolling parent can't clip it.
export default function LaunchMenu({
  siteId,
  anchor,
  onClose,
  onLaunch,
  onOpenSettings,
  agents: agentsProp,
  targets: targetsProp,
  header,
  footer,
}) {
  const [agents, setAgents] = useState(agentsProp || null);
  const [targets, setTargets] = useState(targetsProp || null);

  // Load whatever the caller didn't pass in.
  useEffect(() => {
    let cancelled = false;
    if (!agentsProp) {
      window.electronAPI.listAgents().then((a) => {
        if (!cancelled) setAgents((a || []).filter((x) => x.detected));
      });
    }
    if (!targetsProp) {
      window.electronAPI.listLaunchTargets(siteId).then((t) => {
        if (!cancelled) setTargets(t || []);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [siteId, agentsProp, targetsProp]);

  const list = agentsProp || agents || [];
  const targetList = targetsProp || targets || [];

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="panel fixed z-50 min-w-[200px] max-w-[280px] py-1"
        style={{ left: anchor.x, top: anchor.y }}
      >
        {header}
        {list.map((a) => {
          const agentTargets = targetList.filter((t) => t.agentId === a.id);
          return (
            <div key={a.id}>
              {/* Default launch: webroot + the agent's global flags. */}
              <button
                onClick={() => onLaunch(a.id, null)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
              >
                <ProviderIcon agentId={a.id} brand size={14} />
                {a.name}
              </button>
              {/* Saved targets: a pinned directory (+ optional flags). */}
              {agentTargets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onLaunch(a.id, t.id)}
                  title={t.cwd}
                  className="w-full flex items-center gap-1.5 pl-7 pr-3 py-1 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <CornerDownRight size={11} className="flex-shrink-0" />
                  <span className="truncate">{t.label || t.cwd}</span>
                </button>
              ))}
            </div>
          );
        })}
        {agents && list.length === 0 && (
          <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
            No agents installed.
          </p>
        )}
        {onOpenSettings && (
          <>
            <div className="my-1 h-px bg-border" />
            <button
              onClick={onOpenSettings}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Settings2 size={14} />
              Launch settings…
            </button>
          </>
        )}
        {footer}
      </div>
    </>
  );
}
