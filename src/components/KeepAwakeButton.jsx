import { useEffect, useRef, useState } from 'react';
import { Coffee } from 'lucide-react';
import { useSettings } from '../lib/useSettings';
import { KEEP_AWAKE_MODES, keepAwakeMode, useKeepAwakeStatus } from '../lib/useKeepAwake';

// Keep computer awake, in the sidebar footer: a coffee button showing the mode
// and whether a hold is active, opening an upward On / Agent / Off menu.
// Modelled on Orca's status-bar caffeinate segment.
//
// The mode is read from settings (optimistic, so the label flips on click);
// `active` comes from the main-process status broadcast, since only the
// service knows whether an assertion is actually held.
//
// The sidebar clips its overflow and is narrower than the menu, so the menu is
// rendered `fixed` at the button's viewport position, behind a click-away
// backdrop — the same approach as LaunchMenu.
export default function KeepAwakeButton() {
  const { settings, setSetting } = useSettings();
  const { active } = useKeepAwakeStatus();
  const [anchor, setAnchor] = useState(null);
  const buttonRef = useRef(null);

  const mode = keepAwakeMode(settings['agents.keepAwake']);
  const stateLabel = active ? 'Active' : 'Inactive';

  useEffect(() => {
    if (!anchor) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setAnchor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anchor]);

  const toggle = () => {
    if (anchor) {
      setAnchor(null);
      return;
    }
    const r = buttonRef.current.getBoundingClientRect();
    setAnchor({ left: r.left, bottom: window.innerHeight - r.top + 6 });
  };

  const choose = (value) => {
    setAnchor(null);
    if (value !== mode.value) setSetting('agents.keepAwake', value);
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label={`Keep computer awake: ${mode.label}, ${stateLabel}`}
        title={`Keep computer awake · ${mode.label} · ${stateLabel}`}
        className={`no-drag flex items-center gap-1.5 h-6 px-1.5 rounded-sm text-[11px] transition-colors hover:bg-sidebar-accent ${
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Coffee size={12} strokeWidth={2.2} />
        {mode.label}
        <span
          className={`size-1.5 rounded-full ${
            active ? 'bg-foreground' : 'bg-muted-foreground/40'
          }`}
        />
      </button>

      {anchor && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAnchor(null)} />
          <div
            role="menu"
            aria-label="Keep computer awake"
            className="panel-menu fixed z-50 w-64 p-1"
            style={{ left: anchor.left, bottom: anchor.bottom }}
          >
            <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-2 mb-1 border-b border-border">
              <span className="text-[12px] font-medium text-foreground">
                Keep computer awake
              </span>
              <span className="text-[11px] text-muted-foreground">
                {mode.label} · {stateLabel}
              </span>
            </div>
            {KEEP_AWAKE_MODES.map((m) => {
              const selected = m.value === mode.value;
              return (
                <button
                  key={m.value}
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => choose(m.value)}
                  className="panel-item items-start text-left"
                >
                  <span className="w-3 flex-shrink-0 flex justify-center pt-[5px]">
                    {selected && <span className="size-1.5 rounded-full bg-foreground" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] text-foreground">{m.label}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {m.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
