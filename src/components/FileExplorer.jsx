import { useState, useEffect, useCallback } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Search,
  FilePlus,
  FolderPlus,
  RefreshCw,
  FoldVertical,
  ExternalLink,
  Clipboard,
  Copy,
  Pencil,
  Trash2,
} from 'lucide-react';
import { FileGlyph } from '../lib/fileIcons';

// The macOS path separator; the explorer is confined to a Site's webroot.
const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const relTo = (root, p) => p.slice(root.length).replace(/^\/+/, '');

// Lazy project explorer for the selected Site's directory, with a search
// filter, a toolbar (new file/folder, refresh, collapse all) and a right-click
// context menu (open, reveal, copy path, rename, delete). Mirrors Superset's
// file tree; all mutations are confined to the site root in the main process.
export default function FileExplorer({ rootPath, rootName, onOpenFile }) {
  const [childrenByPath, setChildrenByPath] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(null); // { x, y, entry }
  const [renaming, setRenaming] = useState(null); // { path, draft }
  const [creating, setCreating] = useState(null); // { parentPath, isDir, draft }
  const [error, setError] = useState(null);

  const load = useCallback(
    async (dirPath) => {
      const res = await window.electronAPI.listDirectory(rootPath, dirPath);
      if (res?.entries) {
        setChildrenByPath((prev) => ({ ...prev, [dirPath]: res.entries }));
      }
    },
    [rootPath]
  );

  // Reset and load the root whenever the selected Site changes.
  useEffect(() => {
    setChildrenByPath({});
    setExpanded(new Set([rootPath]));
    setQuery('');
    setMenu(null);
    setRenaming(null);
    setCreating(null);
    setError(null);
    load(rootPath);
  }, [rootPath, load]);

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    const onKey = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const reload = useCallback(
    (dirPath) => {
      // Only refetch already-loaded directories.
      if (childrenByPath[dirPath] !== undefined || dirPath === rootPath) {
        return load(dirPath);
      }
    },
    [childrenByPath, load, rootPath]
  );

  const toggle = async (dirPath) => {
    const isOpen = expanded.has(dirPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      isOpen ? next.delete(dirPath) : next.add(dirPath);
      return next;
    });
    if (!isOpen && !childrenByPath[dirPath]) await load(dirPath);
  };

  const collapseAll = () => setExpanded(new Set([rootPath]));

  const refresh = () => {
    // Refetch every currently-loaded directory.
    Object.keys(childrenByPath).forEach((dir) => load(dir));
    if (!childrenByPath[rootPath]) load(rootPath);
  };

  const startCreate = (isDir) => {
    setExpanded((prev) => new Set(prev).add(rootPath));
    setCreating({ parentPath: rootPath, isDir, draft: '' });
    setError(null);
  };

  const submitCreate = async () => {
    if (!creating) return;
    const name = creating.draft.trim();
    if (!name) return setCreating(null);
    const api = creating.isDir
      ? window.electronAPI.createFolder
      : window.electronAPI.createFile;
    const res = await api(rootPath, creating.parentPath, name);
    if (res?.error) return setError(res.error);
    setCreating(null);
    await reload(creating.parentPath);
  };

  const submitRename = async () => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    if (!name) return setRenaming(null);
    const res = await window.electronAPI.renamePath(rootPath, renaming.path, name);
    if (res?.error) return setError(res.error);
    const parent = parentOf(renaming.path);
    setRenaming(null);
    await reload(parent);
  };

  const doDelete = async (entry) => {
    if (!window.confirm(`Move "${entry.name}" to the Trash?`)) return;
    const res = await window.electronAPI.trashPath(rootPath, entry.path);
    if (res?.error) return setError(res.error);
    await reload(parentOf(entry.path));
  };

  const copy = (text) => navigator.clipboard?.writeText(text);

  const openMenu = (e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // --- search: keep a node if its name matches, or (for dirs) if any loaded
  // descendant matches; matching dirs auto-expand so hits are visible. ---
  const q = query.trim().toLowerCase();
  const subtreeMatches = useCallback(
    (dirPath) => {
      const entries = childrenByPath[dirPath];
      if (!entries) return false;
      return entries.some(
        (en) =>
          en.name.toLowerCase().includes(q) ||
          (en.isDir && subtreeMatches(en.path))
      );
    },
    [childrenByPath, q]
  );
  const visible = (entry) => {
    if (!q) return true;
    if (entry.name.toLowerCase().includes(q)) return true;
    return entry.isDir && subtreeMatches(entry.path);
  };

  const renderNodes = (dirPath, depth) => {
    const entries = childrenByPath[dirPath];
    if (!entries) return null;
    const rows = [];

    // Inline "new file/folder" input at the top of its parent directory.
    if (creating && creating.parentPath === dirPath) {
      rows.push(
        <div
          key="__create__"
          className="flex items-center gap-1.5 py-[3px] pr-2"
          style={{ paddingLeft: (depth + 1) * 12 + 8 }}
        >
          <span className="w-[13px] flex-shrink-0" />
          {creating.isDir ? (
            <Folder size={14} className="text-[#5ac8fa] flex-shrink-0" />
          ) : (
            <FileGlyph name={creating.draft || 'file'} className="flex-shrink-0" />
          )}
          <input
            autoFocus
            value={creating.draft}
            placeholder={creating.isDir ? 'folder name' : 'file name'}
            onChange={(e) => setCreating({ ...creating, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate();
              if (e.key === 'Escape') setCreating(null);
            }}
            onBlur={submitCreate}
            className="flex-1 min-w-0 bg-black/[0.06] dark:bg-white/[0.1] rounded px-1.5 py-0.5 text-[12.5px] outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      );
    }

    entries.forEach((entry) => {
      if (!visible(entry)) return;
      const isOpen =
        entry.isDir && (expanded.has(entry.path) || (q && subtreeMatches(entry.path)));
      const isRenaming = renaming?.path === entry.path;
      rows.push(
        <div key={entry.path}>
          {isRenaming ? (
            <div
              className="flex items-center gap-1.5 py-[3px] pr-2"
              style={{ paddingLeft: depth * 12 + 8 }}
            >
              <span className="w-[13px] flex-shrink-0" />
              {entry.isDir ? (
                <Folder size={14} className="text-[#5ac8fa] flex-shrink-0" />
              ) : (
                <FileGlyph name={entry.name} className="flex-shrink-0" />
              )}
              <input
                autoFocus
                value={renaming.draft}
                onChange={(e) => setRenaming({ ...renaming, draft: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={submitRename}
                className="flex-1 min-w-0 bg-black/[0.06] dark:bg-white/[0.1] rounded px-1.5 py-0.5 text-[12.5px] outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          ) : (
            <button
              onClick={() =>
                entry.isDir ? toggle(entry.path) : onOpenFile?.(entry)
              }
              onContextMenu={(e) => openMenu(e, entry)}
              title={entry.name}
              className="w-full flex items-center gap-1.5 py-[3px] pr-2 rounded-md text-[12.5px] text-gray-800 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              style={{ paddingLeft: depth * 12 + 8 }}
            >
              {entry.isDir ? (
                isOpen ? (
                  <ChevronDown size={13} className="text-gray-500 flex-shrink-0" />
                ) : (
                  <ChevronRight size={13} className="text-gray-500 flex-shrink-0" />
                )
              ) : (
                <span className="w-[13px] flex-shrink-0" />
              )}
              {entry.isDir ? (
                isOpen ? (
                  <FolderOpen size={14} className="text-[#5ac8fa] flex-shrink-0" />
                ) : (
                  <Folder size={14} className="text-[#5ac8fa] flex-shrink-0" />
                )
              ) : (
                <FileGlyph name={entry.name} className="flex-shrink-0" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
          )}
          {isOpen && renderNodes(entry.path, depth + 1)}
        </div>
      );
    });
    return rows;
  };

  const iconBtn =
    'p-1 rounded-md text-gray-500 hover:text-gray-800 hover:bg-black/[0.05] dark:hover:text-gray-200 dark:hover:bg-white/[0.07]';

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wide truncate">
        {rootName || 'Explorer'}
      </div>

      {/* Toolbar: search + new file / new folder / refresh / collapse all */}
      <div className="flex items-center gap-1.5 px-2 pb-2 border-b border-black/[0.06] dark:border-white/[0.08]">
        <div className="flex-1 flex items-center gap-1.5 min-w-0 bg-black/[0.05] dark:bg-white/[0.07] rounded-md px-2 py-1">
          <Search size={13} className="text-gray-400 flex-shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files"
            className="flex-1 min-w-0 bg-transparent text-[12.5px] outline-none placeholder:text-gray-400"
          />
        </div>
        <button className={iconBtn} title="New File" onClick={() => startCreate(false)}>
          <FilePlus size={15} />
        </button>
        <button className={iconBtn} title="New Folder" onClick={() => startCreate(true)}>
          <FolderPlus size={15} />
        </button>
        <button className={iconBtn} title="Refresh" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
        <button className={iconBtn} title="Collapse All" onClick={collapseAll}>
          <FoldVertical size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-2 py-2" onContextMenu={(e) => e.preventDefault()}>
        {renderNodes(rootPath, 0)}
      </div>

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400 truncate border-t border-black/[0.06] dark:border-white/[0.08]" title={error}>
          {error}
        </div>
      )}

      {/* Right-click context menu */}
      {menu && (
        <div
          className="panel fixed z-50 min-w-[190px] py-1 text-[13px]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItem
            icon={ExternalLink}
            label="Open"
            onClick={() => {
              menu.entry.isDir ? toggle(menu.entry.path) : onOpenFile?.(menu.entry);
              setMenu(null);
            }}
          />
          <MenuItem
            icon={Folder}
            label="Reveal in Finder"
            onClick={() => {
              window.electronAPI.revealInFinder(rootPath, menu.entry.path);
              setMenu(null);
            }}
          />
          <div className="my-1 border-t border-black/[0.08] dark:border-white/[0.1]" />
          <MenuItem
            icon={Clipboard}
            label="Copy Path"
            onClick={() => {
              copy(menu.entry.path);
              setMenu(null);
            }}
          />
          <MenuItem
            icon={Copy}
            label="Copy Relative Path"
            onClick={() => {
              copy(relTo(rootPath, menu.entry.path));
              setMenu(null);
            }}
          />
          <div className="my-1 border-t border-black/[0.08] dark:border-white/[0.1]" />
          <MenuItem
            icon={Pencil}
            label="Rename…"
            onClick={() => {
              setRenaming({ path: menu.entry.path, draft: menu.entry.name });
              setMenu(null);
            }}
          />
          <MenuItem
            icon={Trash2}
            label="Delete"
            danger
            onClick={() => {
              const entry = menu.entry;
              setMenu(null);
              doDelete(entry);
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ${
        danger ? 'text-red-600 dark:text-red-400' : 'text-gray-800'
      }`}
    >
      <Icon size={14} className="flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
