import { useState } from 'react';
import { FolderOpen, Globe, Shapes, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Popover } from './tasks/pickers';
import { WordPressIcon } from './icons';
import { useOpenLink } from '../lib/useOpenLink';

// A project's ⋯ menu in the Agents sidebar, after Orca's project actions:
// settings and icon first, the Site's own places in the middle, Remove at the
// bottom in red. Remove only takes the Site out of the Agents working set —
// the Site itself stays.

function Item({ icon: Icon, danger = false, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-accent ${
        danger ? 'text-destructive' : 'text-foreground'
      }`}
    >
      <Icon size={14} className={danger ? '' : 'text-muted-foreground'} />
      {children}
    </button>
  );
}

const Divider = () => <div className="my-1 h-px bg-border" />;

export default function ProjectMenu({
  site,
  anchor,
  onClose,
  onSettings,
  onChangeIcon,
  onOpenSite,
  onRemove,
}) {
  const openLink = useOpenLink();
  const [error, setError] = useState(null);
  const run = (fn) => () => {
    onClose();
    fn();
  };

  const openAdmin = async () => {
    const res = await window.electronAPI.getWpAdminUrl(site.id);
    if (res?.success) {
      onClose();
      openLink(res.url, site.id);
    } else {
      setError(res?.error || 'Couldn’t open WP Admin.');
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={220}>
      <Item icon={SlidersHorizontal} onClick={run(onSettings)}>
        Project Settings
      </Item>
      <Item
        icon={Shapes}
        onClick={() => {
          // The picker takes the menu's place, anchored where it was.
          onClose();
          onChangeIcon();
        }}
      >
        Change Project Icon
      </Item>
      <Divider />
      <Item icon={Globe} onClick={run(onOpenSite)}>
        Open Site
      </Item>
      <Item icon={WordPressIcon} onClick={openAdmin}>
        Open WP Admin
      </Item>
      <Item
        icon={FolderOpen}
        onClick={run(() => window.electronAPI.openSiteInFinder(site.path))}
      >
        Reveal in Finder
      </Item>
      <Divider />
      <Item icon={Trash2} danger onClick={run(onRemove)}>
        Remove Project
      </Item>
      {error && (
        <p className="px-2.5 pb-1 pt-0.5 text-[11.5px] text-destructive">{error}</p>
      )}
    </Popover>
  );
}
