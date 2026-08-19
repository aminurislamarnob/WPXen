import { useEffect, useState } from 'react';
import { Layers, Loader, Trash2 } from 'lucide-react';
import { Card, SectionLabel, Tooltip } from '../../ui';

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

export default function BlueprintsSection() {
  const [blueprints, setBlueprints] = useState([]);
  const [deleting, setDeleting] = useState(null);

  function refresh() {
    window.electronAPI
      .getBlueprints()
      .then((r) => setBlueprints(r.success ? r.blueprints : []))
      .catch(() => setBlueprints([]));
  }

  useEffect(refresh, []);

  async function handleDelete(id) {
    setDeleting(id);
    await window.electronAPI.deleteBlueprint(id);
    setDeleting(null);
    refresh();
  }

  return (
    <div>
      <SectionLabel>Site Blueprints</SectionLabel>
      <Card>
        {blueprints.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-5 text-[13px] text-muted-foreground">
            <Layers size={18} className="text-muted-foreground flex-shrink-0" />
            <span>
              No blueprints yet. Save one from a site’s menu (
              <span className="font-medium">Save as Blueprint…</span>) to create new sites
              from it.
            </span>
          </div>
        ) : (
          blueprints.map((bp) => (
            <div key={bp.id} className="settings-row">
              <Layers size={18} className="text-highlight flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-foreground truncate">{bp.name}</p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {`${bp.sourceSiteName ? `From ${bp.sourceSiteName} · ` : ''}PHP ${bp.phpVersion} · ${formatBytes(bp.sizeBytes)}${
                    bp.description ? ` · ${bp.description}` : ''
                  }`}
                </p>
              </div>
              <Tooltip label="Delete blueprint">
                <button
                  onClick={() => handleDelete(bp.id)}
                  disabled={deleting === bp.id}
                  aria-label="Delete blueprint"
                  className="btn-ghost text-xs text-muted-foreground hover:text-destructive"
                >
                  {deleting === bp.id ? (
                    <Loader size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                </button>
              </Tooltip>
            </div>
          ))
        )}
      </Card>
      <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
        Blueprints are full snapshots (files + database) stored in WPXen’s data folder.
        Create a site from one via{' '}
        <span className="font-medium">Add Site → From Blueprint</span>.
      </p>
    </div>
  );
}
