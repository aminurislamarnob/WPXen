import { useEffect, useRef, useState } from 'react';
import { ImageUp, Loader2, Wand2 } from 'lucide-react';
import { SegmentedTabs } from './ui';
import { Popover } from './tasks/pickers';
import ProjectIcon from './ProjectIcon';

// Change Project Icon, from a project's ⋯ menu: Automatic (Site Icon → repo
// icon → WordPress logo), an emoji from a short grid or typed, or an uploaded
// PNG/WebP up to 256 KB. Picking applies at once; the main process keeps the
// choice on the Site and tells every window to redraw.

const MAX_BYTES = 256 * 1024;

// Project-ish emoji: making, shipping, shops, content, people, nature.
const EMOJI = [
  '🔥',
  '🚀',
  '⚡',
  '✨',
  '🌟',
  '💡',
  '🎯',
  '🧪',
  '🛠️',
  '⚙️',
  '🧩',
  '📦',
  '🗂️',
  '📁',
  '🧱',
  '🏗️',
  '🔧',
  '🔒',
  '🛡️',
  '🐛',
  '🛒',
  '🛍️',
  '💳',
  '💰',
  '📈',
  '📊',
  '🏷️',
  '🧾',
  '🏪',
  '🎁',
  '📝',
  '📰',
  '📚',
  '✏️',
  '🎨',
  '🖼️',
  '📷',
  '🎬',
  '🎵',
  '🎮',
  '💬',
  '📣',
  '✉️',
  '👥',
  '🤝',
  '❤️',
  '🏠',
  '🌍',
  '🗺️',
  '✈️',
  '🍕',
  '☕',
  '🌱',
  '🌸',
  '🌊',
  '🌙',
  '☀️',
  '🐶',
  '🐱',
  '🦊',
];

const TABS = [
  { value: 'auto', label: 'Automatic', icon: Wand2 },
  { value: 'emoji', label: 'Emoji' },
  { value: 'image', label: 'Image', icon: ImageUp },
];

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function ProjectIconPicker({ site, anchor, onClose }) {
  const current = site.icon?.type;
  const [tab, setTab] = useState(
    current === 'emoji' || current === 'image' ? current : 'auto'
  );
  const [typed, setTyped] = useState(site.icon?.type === 'emoji' ? site.icon.emoji : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => setError(null), [tab]);

  const apply = async (choice) => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.electronAPI.setProjectIcon(site.id, choice);
      if (res?.error) setError(res.error);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file) => {
    if (!file) return;
    if (!/^image\/(png|webp)$/.test(file.type))
      return setError('Use a PNG or WebP image.');
    if (file.size > MAX_BYTES) return setError('Images must be 256 KB or smaller.');
    // The main process checks the bytes too; this just answers sooner.
    apply({ type: 'image', data: await readBase64(file) });
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={300}>
      <div className="p-2 space-y-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
            <ProjectIcon siteId={site.id} size={22} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-foreground">
              {site.name}
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              {current === 'emoji'
                ? 'Custom emoji'
                : current === 'image'
                  ? 'Custom image'
                  : 'Automatic'}
            </p>
          </div>
          {busy && (
            <Loader2 size={14} className="ml-auto animate-spin text-muted-foreground" />
          )}
        </div>

        <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} className="w-full" />

        {tab === 'auto' && (
          <div className="space-y-2">
            <p className="text-[12px] leading-snug text-muted-foreground">
              {site.kind === 'folder'
                ? 'If the folder is a GitHub repo, the repo’s icon or owner avatar; otherwise a folder.'
                : 'The Site’s WordPress Site Icon; if its folder is a GitHub repo, the repo’s icon or owner avatar; otherwise the WordPress logo.'}
            </p>
            <button
              className="btn btn-secondary w-full"
              disabled={busy || !current}
              onClick={() => apply({ type: 'auto' })}
            >
              {current ? 'Reset to automatic' : 'Using automatic'}
            </button>
          </div>
        )}

        {tab === 'emoji' && (
          <div className="space-y-2">
            <div className="grid grid-cols-10 gap-0.5">
              {EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  disabled={busy}
                  onClick={() => apply({ type: 'emoji', emoji: e })}
                  className={`flex size-[26px] items-center justify-center rounded-md text-[16px] hover:bg-accent ${
                    current === 'emoji' && site.icon.emoji === e ? 'bg-accent' : ''
                  }`}
                  aria-label={`Use ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
            <form
              className="flex gap-1.5"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (typed.trim()) apply({ type: 'emoji', emoji: typed.trim() });
              }}
            >
              <input
                value={typed}
                onChange={(ev) => setTyped(ev.target.value)}
                placeholder="Or type one — ⌃⌘Space"
                aria-label="Emoji"
                className="form-input !h-8 flex-1 !text-[13px]"
              />
              <button className="btn btn-primary" disabled={busy || !typed.trim()}>
                Use
              </button>
            </form>
          </div>
        )}

        {tab === 'image' && (
          <div className="space-y-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              onDragOver={(ev) => ev.preventDefault()}
              onDrop={(ev) => {
                ev.preventDefault();
                upload(ev.dataTransfer.files?.[0]);
              }}
              className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-5 text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <ImageUp size={18} />
              Choose or drop a PNG or WebP — up to 256 KB
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/webp"
              className="hidden"
              onChange={(ev) => {
                upload(ev.target.files?.[0]);
                ev.target.value = '';
              }}
            />
          </div>
        )}

        {error && <p className="text-[12px] text-destructive">{error}</p>}
      </div>
    </Popover>
  );
}
