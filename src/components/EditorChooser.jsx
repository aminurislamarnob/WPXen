import { useCallback, useState } from 'react';
import { ConfirmDialog } from './ui';

// "Open in Editor" for a folder. The main process tries WPXen's editor
// setting, then the macOS default code editor; when neither gives one it
// returns { needsChoice } and this asks which editor to use. Ticking
// "Remember" writes the answer to Settings → External Tools, so it comes
// first next time — WPXen's setting always outranks the system default.
export function useOpenInEditor() {
  const [pending, setPending] = useState(null); // { path, editors } while asking

  const open = useCallback(async (path) => {
    const api = window.electronAPI;
    const res = await api.openFilePath(path);
    if (!res?.needsChoice) return;
    const tools = await api.listExternalTools().catch(() => null);
    setPending({ path, editors: tools?.editors || [] });
  }, []);

  const dialog = pending && (
    <EditorChooser
      editors={pending.editors}
      onCancel={() => setPending(null)}
      onPick={async (editorId, remember) => {
        const { path } = pending;
        setPending(null);
        if (remember) await window.electronAPI.setSettings({ 'tools.editor': editorId });
        window.electronAPI.openFilePath(path, editorId);
      }}
    />
  );

  return { open, dialog };
}

function EditorChooser({ editors, onPick, onCancel }) {
  // Installed editors first; the rest stay listed, since `open -a` can still
  // find an app the detection missed.
  const sorted = [...editors].sort((a, b) => Number(b.detected) - Number(a.detected));
  const [choice, setChoice] = useState(
    () => (sorted.find((e) => e.detected) || sorted[0])?.id || null
  );
  const [remember, setRemember] = useState(true);

  return (
    <ConfirmDialog
      open
      danger={false}
      title="Open in which editor?"
      description="No default code editor is set on this Mac."
      confirmLabel="Open"
      onCancel={onCancel}
      onConfirm={() => choice && onPick(choice, remember)}
    >
      <div className="mt-3 flex flex-col gap-0.5" role="radiogroup">
        {sorted.map((e) => (
          <label
            key={e.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent cursor-pointer"
          >
            <input
              type="radio"
              name="editor"
              checked={choice === e.id}
              onChange={() => setChoice(e.id)}
              className="accent-highlight"
            />
            <span className="flex-1">{e.label}</span>
            {!e.detected && (
              <span className="text-[11.5px] text-muted-foreground">Not found</span>
            )}
          </label>
        ))}
      </div>
      <label className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="accent-highlight"
        />
        Remember in Settings → External Tools
      </label>
    </ConfirmDialog>
  );
}
