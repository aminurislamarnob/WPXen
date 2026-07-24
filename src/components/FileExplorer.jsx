import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
  UnfoldVertical,
  ListTree,
  ExternalLink,
  Clipboard,
  Copy,
  Pencil,
  Trash2,
  FileText,
  GitBranch,
  GitCompare,
  Plus,
  Minus,
  Undo2,
} from 'lucide-react';
import { FileGlyph } from '../lib/fileIcons';
import { ConfirmDialog } from './ui';

// Per-status dot color + human label for the Changes list, mirroring
// source-control UIs (a colored dot rather than a letter).
const STATUS_DOT = {
  M: { cls: 'bg-amber-500', label: 'Modified' },
  A: { cls: 'bg-green-500', label: 'Added' },
  D: { cls: 'bg-red-500', label: 'Deleted' },
  R: { cls: 'bg-blue-400', label: 'Renamed' },
  C: { cls: 'bg-blue-400', label: 'Copied' },
  '?': { cls: 'bg-green-500', label: 'Untracked' },
};
const statusDot = (s) => STATUS_DOT[s] || { cls: 'bg-gray-400', label: s || 'Changed' };

// Filename tint for git-modified entries in the Files tree (VS Code style).
const NAME_TINT = {
  M: 'text-amber-600 dark:text-amber-400',
  A: 'text-green-600 dark:text-green-400',
  '?': 'text-green-600 dark:text-green-400',
  D: 'text-red-600 dark:text-red-400 line-through',
  R: 'text-blue-600 dark:text-blue-400',
  C: 'text-blue-600 dark:text-blue-400',
};
const dirOf = (rel, name) => rel.slice(0, rel.length - name.length).replace(/\/$/, '');
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

// The macOS path separator; the explorer is confined to a Site's webroot.
const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const relTo = (root, p) => p.slice(root.length).replace(/^\/+/, '');

// Shared toolbar icon-button styling (Files toolbar + Changes toolbar).
const iconBtn =
  'p-1 rounded-md text-gray-500 hover:text-gray-800 hover:bg-black/[0.05] dark:hover:text-gray-200 dark:hover:bg-white/[0.07]';

// Lazy project explorer for the selected Site's directory, with a search
// filter, a toolbar (new file/folder, refresh, collapse all) and a right-click
// context menu (open, reveal, copy path, rename, delete). Mirrors Superset's
// file tree; all mutations are confined to the site root in the main process.
export default function FileExplorer({
  rootPath,
  rootName,
  onOpenFile,
  onOpenDiff,
  insetForControls,
}) {
  const [childrenByPath, setChildrenByPath] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(null); // { x, y, entry }
  const [renaming, setRenaming] = useState(null); // { path, draft }
  const [creating, setCreating] = useState(null); // { parentPath, isDir, draft }
  const [error, setError] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // dir path being dragged over, or null

  const [tab, setTab] = useState('files'); // 'files' | 'changes'
  const [changes, setChanges] = useState(null); // git status result
  const [changesState, setChangesState] = useState('loading'); // idle|loading|error
  const [refreshing, setRefreshing] = useState(false); // spinner during any refetch
  const [foldSignal, setFoldSignal] = useState({ epoch: 0, action: 'collapse' });
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem('wpherd.changesViewMode') === 'tree' ? 'tree' : 'folders';
    } catch {
      return 'folders';
    }
  });
  const changesRef = useRef(null); // last good result, to suppress the loading flash
  const inFlightRef = useRef(false); // dedupe overlapping fetches
  const [changesError, setChangesError] = useState(null); // last git mutation error
  const [discardTarget, setDiscardTarget] = useState(null); // file pending discard confirm
  const [deleteTarget, setDeleteTarget] = useState(null); // tree entry pending delete confirm

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
    setTab('files');
    setChanges(null);
    changesRef.current = null;
    setChangesState('loading');
    setChangesError(null);
    setDiscardTarget(null);
    setDeleteTarget(null);
    setDropTarget(null);
    load(rootPath);
  }, [rootPath, load]);

  // Git source-control status for the Changes tab. `silent` keeps the existing
  // view in place during background polls (no loading flash); overlapping
  // fetches are deduped so a slow git call can't stack up behind the poll.
  const loadChanges = useCallback(
    async (opts = {}) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      if (!opts.silent && !changesRef.current) setChangesState('loading');
      setRefreshing(true);
      const res = await window.electronAPI.gitStatus(rootPath);
      inFlightRef.current = false;
      setRefreshing(false);
      if (res?.error) {
        changesRef.current = null;
        setChanges(null);
        setChangesState('error');
        return;
      }
      changesRef.current = res;
      setChanges(res);
      setChangesState('idle');
    },
    [rootPath]
  );

  // Keep git status live while the explorer is mounted: poll every 5s and
  // refetch on window focus (agents edit files out-of-band). Runs on both tabs
  // so the Files tree's git decorations and the Changes badge stay current.
  useEffect(() => {
    loadChanges({ silent: true });
    const onFocus = () => loadChanges({ silent: true });
    const id = setInterval(() => loadChanges({ silent: true }), 5000);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadChanges]);

  // Collapse/expand every Changes section (and, in the grouped views, every
  // folder/tree node) at once. `foldSignal.epoch` bumps so children re-apply.
  const toggleFold = () => {
    const action = allCollapsed ? 'expand' : 'collapse';
    setAllCollapsed((v) => !v);
    setFoldSignal((s) => ({ epoch: s.epoch + 1, action }));
  };

  // Switch the Changes list between the folders (grouped by parent) and tree
  // (full hierarchy) views, persisting the choice across sessions.
  const toggleViewMode = () =>
    setViewMode((m) => {
      const next = m === 'folders' ? 'tree' : 'folders';
      try {
        localStorage.setItem('wpherd.changesViewMode', next);
      } catch {
        /* private mode — fall back to session-only */
      }
      return next;
    });

  // Stage / unstage / discard from the Changes tab, then silently refresh so
  // the list reflects the new index/worktree state without a loading flash.
  const runChangeMutation = useCallback(
    async (fn) => {
      const res = await fn();
      setChangesError(res?.error || null);
      loadChanges({ silent: true });
    },
    [loadChanges]
  );
  const doStage = useCallback(
    (repoRoot, rels) =>
      runChangeMutation(() => window.electronAPI.gitStage(rootPath, repoRoot, rels)),
    [runChangeMutation, rootPath]
  );
  const doUnstage = useCallback(
    (repoRoot, rels) =>
      runChangeMutation(() => window.electronAPI.gitUnstage(rootPath, repoRoot, rels)),
    [runChangeMutation, rootPath]
  );
  const confirmDiscard = () => {
    const file = discardTarget;
    setDiscardTarget(null);
    if (file) {
      runChangeMutation(() =>
        window.electronAPI.gitDiscard(rootPath, file.repoRoot, file.rel, file.status)
      );
    }
  };

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

  const confirmDelete = async () => {
    const entry = deleteTarget;
    setDeleteTarget(null);
    if (!entry) return;
    const res = await window.electronAPI.trashPath(rootPath, entry.path);
    if (res?.error) return setError(res.error);
    await reload(parentOf(entry.path));
  };

  // Git decorations for the Files tree: which paths are changed (→ tinted
  // filenames) and which directories contain a change (→ trailing dot). Keyed
  // by site-root-relative path (from each file's absolute path) so it works
  // across every discovered repo, not just one relative to the site root.
  const gitDecor = useMemo(() => {
    const fileStatus = new Map();
    const dirs = new Set();
    if (changes?.isRepo) {
      for (const repo of changes.repos) {
        for (const f of repo.files) {
          const siteRel = relTo(rootPath, f.path);
          // A file may appear staged + unstaged; the first (unstaged) status wins.
          if (!fileStatus.has(siteRel)) fileStatus.set(siteRel, f.status);
          const parts = siteRel.split('/');
          parts.pop();
          let acc = '';
          for (const seg of parts) {
            acc = acc ? `${acc}/${seg}` : seg;
            dirs.add(acc);
          }
        }
      }
    }
    return { fileStatus, dirs };
  }, [changes, rootPath]);

  const copy = (text) => navigator.clipboard?.writeText(text);

  // --- Drag & drop upload from Finder. Files dropped on a folder land in it;
  // anywhere else in the tree lands in the site root. Confined in the main
  // process; the tree area is the drop zone, folder rows override the target.
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  const onTreeDragOver = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(rootPath);
  };
  const onFolderDragOver = (e, dirPath) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation(); // keep the container from resetting the target to root
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(dirPath);
  };
  const onTreeDragLeave = (e) => {
    // Only clear when the pointer truly leaves the tree pane, not on inner moves.
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDropTarget(null);
  };
  const onTreeDrop = async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const target = dropTarget || rootPath;
    setDropTarget(null);
    const paths = Array.from(e.dataTransfer.files || [])
      .map((f) => f.path)
      .filter(Boolean);
    if (paths.length === 0) return;
    const res = await window.electronAPI.importFiles(rootPath, target, paths);
    if (res?.error) return setError(res.error);
    setError(null);
    setExpanded((prev) => new Set(prev).add(target));
    await load(target); // refresh the destination so the new items show
  };

  const openMenu = (e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // Right-click menu for a Changes row (open diff/file, copy paths, reveal).
  const openChangeMenu = (e, change) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, change });
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
      // Git decoration: tint changed files, dot directories with changes.
      const rel = relTo(rootPath, entry.path);
      const nameTint = entry.isDir ? '' : NAME_TINT[gitDecor.fileStatus.get(rel)] || '';
      const dirChanged = entry.isDir && gitDecor.dirs.has(rel);
      const isDropTarget = entry.isDir && dropTarget === entry.path;
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
              onDragOver={entry.isDir ? (e) => onFolderDragOver(e, entry.path) : undefined}
              title={entry.name}
              className={`w-full flex items-center gap-1.5 py-[3px] pr-2 rounded-md text-[12.5px] text-gray-800 ${
                isDropTarget
                  ? 'bg-blue-50 dark:bg-blue-500/15 ring-1 ring-blue-400'
                  : 'hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'
              }`}
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
              <span className={`truncate ${nameTint}`}>{entry.name}</span>
              {dirChanged && (
                <span
                  className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
                  title="Contains changes"
                />
              )}
            </button>
          )}
          {isOpen && renderNodes(entry.path, depth + 1)}
        </div>
      );
    });
    return rows;
  };

  const changeCount = changes?.isRepo
    ? changes.repos.reduce((n, r) => n + r.files.length, 0)
    : 0;

  return (
    <div className="h-full flex flex-col">
      {/* Files / Changes tabs. When the app sidebar is hidden, inset past the
          floating window controls so they don't overlap the tabs. */}
      <div
        className="flex items-center gap-0.5 px-2 pt-2 pb-1.5 border-b border-black/[0.06] dark:border-white/[0.08]"
        style={insetForControls ? { paddingLeft: 190 } : undefined}
      >
        <TabButton
          icon={FileText}
          label="Files"
          active={tab === 'files'}
          onClick={() => setTab('files')}
        />
        <TabButton
          icon={GitBranch}
          label="Changes"
          badge={changeCount}
          active={tab === 'changes'}
          onClick={() => setTab('changes')}
        />
      </div>

      {tab === 'files' ? (
        <>
          <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wide truncate">
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

          <div
            className={`relative flex-1 overflow-auto px-2 py-2 ${
              dropTarget === rootPath ? 'ring-1 ring-inset ring-blue-400 bg-blue-50/40 dark:bg-blue-500/10' : ''
            }`}
            onContextMenu={(e) => e.preventDefault()}
            onDragOver={onTreeDragOver}
            onDragLeave={onTreeDragLeave}
            onDrop={onTreeDrop}
          >
            {renderNodes(rootPath, 0)}
            {dropTarget !== null && (
              <div className="pointer-events-none sticky bottom-0 left-0 right-0 flex justify-center pt-2">
                <span className="rounded-full bg-blue-500 text-white text-[11px] px-2.5 py-1 shadow-sm">
                  Drop to upload to{' '}
                  {dropTarget === rootPath ? rootName || 'project root' : baseOf(dropTarget)}
                </span>
              </div>
            )}
          </div>

          {error && (
            <div className="px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400 truncate border-t border-black/[0.06] dark:border-white/[0.08]" title={error}>
              {error}
            </div>
          )}
        </>
      ) : (
        <ChangesView
          changes={changes}
          state={changesState}
          refreshing={refreshing}
          onRefresh={() => loadChanges()}
          onOpenDiff={onOpenDiff}
          onRowContext={openChangeMenu}
          onStage={doStage}
          onUnstage={doUnstage}
          onDiscard={(file) => setDiscardTarget(file)}
          changesError={changesError}
          foldSignal={foldSignal}
          allCollapsed={allCollapsed}
          onToggleFold={toggleFold}
          viewMode={viewMode}
          onToggleViewMode={toggleViewMode}
        />
      )}

      {/* Right-click context menu — Changes row vs. file-tree entry. */}
      {menu && menu.change && (
        <div
          className="panel fixed z-50 min-w-[190px] py-1 text-[13px]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItem
            icon={GitCompare}
            label="Open Diff"
            disabled={menu.change.status === 'D'}
            onClick={() => {
              if (menu.change.status !== 'D') onOpenDiff?.(menu.change);
              setMenu(null);
            }}
          />
          <MenuItem
            icon={ExternalLink}
            label="Open File"
            disabled={menu.change.status === 'D'}
            onClick={() => {
              if (menu.change.status !== 'D') {
                onOpenFile?.({ path: menu.change.path, name: menu.change.name });
              }
              setMenu(null);
            }}
          />
          <div className="my-1 border-t border-black/[0.08] dark:border-white/[0.1]" />
          <MenuItem
            icon={Clipboard}
            label="Copy Path"
            onClick={() => {
              copy(menu.change.path);
              setMenu(null);
            }}
          />
          <MenuItem
            icon={Copy}
            label="Copy Relative Path"
            onClick={() => {
              copy(menu.change.rel);
              setMenu(null);
            }}
          />
          <MenuItem
            icon={Folder}
            label="Reveal in Finder"
            onClick={() => {
              window.electronAPI.revealInFinder(rootPath, menu.change.path);
              setMenu(null);
            }}
          />
        </div>
      )}
      {menu && menu.entry && (
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
              setDeleteTarget(entry);
            }}
          />
        </div>
      )}

      {/* Delete confirmation for a Files-tree entry. */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={`Move “${deleteTarget?.name}” to the Trash?`}
        description={
          deleteTarget?.isDir
            ? 'This folder and its contents will be moved to the Trash.'
            : 'This file will be moved to the Trash.'
        }
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Discard/delete confirmation for a Changes row. */}
      <ConfirmDialog
        open={!!discardTarget}
        title={
          discardTarget?.status === '?'
            ? `Delete “${discardTarget?.name}”?`
            : `Discard changes to “${discardTarget?.name}”?`
        }
        description={
          discardTarget?.status === '?'
            ? 'This moves the untracked file to the Trash.'
            : 'This reverts the file to its last committed or staged state and cannot be undone.'
        }
        confirmLabel={discardTarget?.status === '?' ? 'Delete' : 'Discard'}
        onConfirm={confirmDiscard}
        onCancel={() => setDiscardTarget(null)}
      />
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left ${
        disabled
          ? 'opacity-40 cursor-default'
          : 'hover:bg-black/[0.06] dark:hover:bg-white/[0.08]'
      } ${danger ? 'text-red-600 dark:text-red-400' : 'text-gray-800'}`}
    >
      <Icon size={14} className="flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// One explorer tab (Files / Changes), with an optional count badge.
function TabButton({ icon: Icon, label, active, badge, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12.5px] ${
        active
          ? 'bg-black/[0.06] dark:bg-white/[0.1] text-gray-900 font-medium'
          : 'text-gray-500 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
      }`}
    >
      <Icon size={13} strokeWidth={2} className="flex-shrink-0" />
      {label}
      {badge > 0 && (
        <span className="min-w-[16px] px-1 text-center rounded-full bg-black/10 dark:bg-white/15 text-[10.5px] font-semibold">
          {badge}
        </span>
      )}
    </button>
  );
}

// Source-control view: current branch, a changeset toolbar (totals, refresh,
// collapse-all), and the changed files split into Unstaged / Staged sections.
// Clicking a file opens it in the editor (deleted files are shown but not
// openable). Mirrors Superset's Changes tab.
function ChangesView({
  changes,
  state,
  refreshing,
  onRefresh,
  onOpenDiff,
  onRowContext,
  onStage,
  onUnstage,
  onDiscard,
  changesError,
  foldSignal,
  allCollapsed,
  onToggleFold,
  viewMode,
  onToggleViewMode,
}) {
  if (state === 'loading' && !changes) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-gray-500">
        Loading changes…
      </div>
    );
  }
  if (state === 'error' || !changes?.isRepo) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-4 text-gray-500">
        <GitBranch size={22} className="mb-2 opacity-60" />
        <p className="text-[12.5px]">
          {state === 'error'
            ? 'Could not read git status.'
            : 'This project is not a git repository.'}
        </p>
      </div>
    );
  }

  const repos = changes.repos || [];
  const totalFiles = repos.reduce((n, r) => n + r.files.length, 0);
  const totalAdd = repos.reduce((n, r) => n + r.additions, 0);
  const totalDel = repos.reduce((n, r) => n + r.deletions, 0);
  // Single repo at the project root → keep the flat, un-grouped look.
  const singleRoot = repos.length === 1 && repos[0].relRoot === '';

  // A row opens a diff against the right base: unstaged edits diff against the
  // index when the file also has staged edits (in the same repo), else HEAD.
  const stagedKeys = new Set();
  for (const r of repos) {
    for (const f of r.files) {
      if (f.source === 'staged') stagedKeys.add(`${f.repoRoot} ${f.rel}`);
    }
  }
  const enrich = (file) => ({
    ...file,
    hasStagedTwin:
      file.source === 'unstaged' && stagedKeys.has(`${file.repoRoot} ${file.rel}`),
  });
  const handlers = {
    onOpen: (file) => onOpenDiff?.(enrich(file)),
    onContext: (e, file) => onRowContext?.(e, enrich(file)),
    onStage: (repoRoot, rels) => onStage?.(repoRoot, rels),
    onUnstage: (repoRoot, rels) => onUnstage?.(repoRoot, rels),
    onDiscard: (file) => onDiscard?.(enrich(file)),
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Branch header — only for a single repo at the root; multi/nested repos
          show their branch in each repo group header instead. */}
      {singleRoot && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-gray-800 border-b border-black/[0.06] dark:border-white/[0.08]">
          <GitBranch size={14} className="text-gray-500 flex-shrink-0" />
          <span className="truncate" title={repos[0].branch}>
            {repos[0].branch}
          </span>
        </div>
      )}

      {/* Toolbar: totals + refresh + collapse-all */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-gray-500 border-b border-black/[0.06] dark:border-white/[0.08]">
        <span className="whitespace-nowrap">
          {totalFiles} {totalFiles === 1 ? 'file' : 'files'}
        </span>
        {!singleRoot && repos.length > 1 && (
          <span className="whitespace-nowrap">
            · {repos.length} repos
          </span>
        )}
        {(totalAdd > 0 || totalDel > 0) && (
          <span className="whitespace-nowrap tabular-nums">
            {totalAdd > 0 && (
              <span className="text-green-500 dark:text-green-400">+{totalAdd}</span>
            )}
            {totalAdd > 0 && totalDel > 0 && ' '}
            {totalDel > 0 && (
              <span className="text-red-500 dark:text-red-400 ml-0.5">−{totalDel}</span>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            className={iconBtn}
            title={viewMode === 'folders' ? 'Tree view' : 'Folder view'}
            onClick={onToggleViewMode}
          >
            {viewMode === 'folders' ? <ListTree size={14} /> : <Folder size={14} />}
          </button>
          <button className={iconBtn} title="Refresh" onClick={onRefresh}>
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            className={iconBtn}
            title={allCollapsed ? 'Expand all' : 'Collapse all'}
            onClick={onToggleFold}
          >
            {allCollapsed ? <UnfoldVertical size={14} /> : <FoldVertical size={14} />}
          </button>
        </div>
      </div>

      {totalFiles === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[12px] text-gray-500">
          No changes — working tree clean.
        </div>
      ) : (
        <div className="flex-1 overflow-auto py-1">
          {repos
            .filter((r) => r.files.length > 0)
            .map((repo) => (
              <RepoGroup
                key={repo.root}
                repo={repo}
                showHeader={!singleRoot}
                viewMode={viewMode}
                foldSignal={foldSignal}
                handlers={handlers}
              />
            ))}
        </div>
      )}

      {changesError && (
        <div
          className="px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400 truncate border-t border-black/[0.06] dark:border-white/[0.08]"
          title={changesError}
        >
          {changesError}
        </div>
      )}
    </div>
  );
}

// One git repository's changes: an optional header (repo name + branch +
// totals) shown when the project has multiple or nested repos, then that
// repo's Unstaged / Staged sections. Stage/unstage target this repo's root.
function RepoGroup({ repo, showHeader, viewMode, foldSignal, handlers }) {
  const unstaged = repo.files.filter((f) => f.source === 'unstaged');
  const staged = repo.files.filter((f) => f.source === 'staged');

  return (
    <div className="mb-1">
      {showHeader && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] font-medium text-gray-700 border-b border-black/[0.04] dark:border-white/[0.06]">
          <GitBranch size={13} className="text-gray-500 flex-shrink-0" />
          <span className="truncate" title={repo.relRoot || repo.name}>
            {repo.name}
          </span>
          <span className="text-gray-400 flex-shrink-0">·</span>
          <span className="text-gray-500 truncate flex-shrink-0" title={repo.branch}>
            {repo.branch}
          </span>
          {(repo.additions > 0 || repo.deletions > 0) && (
            <span className="ml-auto flex-shrink-0 text-[10.5px] tabular-nums">
              {repo.additions > 0 && (
                <span className="text-green-500 dark:text-green-400">+{repo.additions}</span>
              )}
              {repo.additions > 0 && repo.deletions > 0 && ' '}
              {repo.deletions > 0 && (
                <span className="text-red-500 dark:text-red-400">−{repo.deletions}</span>
              )}
            </span>
          )}
        </div>
      )}
      {unstaged.length > 0 && (
        <ChangesSection
          id={`${repo.relRoot}:unstaged`}
          title="Unstaged"
          count={unstaged.length}
          foldSignal={foldSignal}
          action={
            <SectionAction
              icon={Plus}
              label="Stage all"
              onClick={() => handlers.onStage(repo.root, unstaged.map((f) => f.rel))}
            />
          }
        >
          <SectionBody
            files={unstaged}
            viewMode={viewMode}
            foldSignal={foldSignal}
            handlers={handlers}
          />
        </ChangesSection>
      )}
      {staged.length > 0 && (
        <ChangesSection
          id={`${repo.relRoot}:staged`}
          title="Staged"
          count={staged.length}
          foldSignal={foldSignal}
          action={
            <SectionAction
              icon={Minus}
              label="Unstage all"
              onClick={() => handlers.onUnstage(repo.root, staged.map((f) => f.rel))}
            />
          }
        >
          <SectionBody
            files={staged}
            viewMode={viewMode}
            foldSignal={foldSignal}
            handlers={handlers}
          />
        </ChangesSection>
      )}
    </div>
  );
}

// One collapsible group in the Changes list (Unstaged / Staged). Responds to
// the toolbar's collapse-all / expand-all signal. `action` is an optional
// header button (stage-all / unstage-all) revealed on hover.
function ChangesSection({ id, title, count, foldSignal, action, children }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (foldSignal.epoch === 0) return; // ignore the initial (untriggered) value
    setOpen(foldSignal.action === 'expand');
  }, [foldSignal]);

  return (
    <div className="mb-1 group/section" data-section={id}>
      <div className="flex items-center pr-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 flex items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        >
          {open ? (
            <ChevronDown size={12} className="flex-shrink-0" />
          ) : (
            <ChevronRight size={12} className="flex-shrink-0" />
          )}
          <span className="truncate">{title}</span>
          <span className="min-w-[16px] px-1 text-center rounded-full bg-black/10 dark:bg-white/15 text-[10px] font-semibold text-gray-500 normal-case">
            {count}
          </span>
        </button>
        {action && (
          <div className="opacity-0 group-hover/section:opacity-100 transition-opacity">
            {action}
          </div>
        )}
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

// A small text+icon action shown in a section header (stage-all / unstage-all).
function SectionAction({ icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-gray-500 hover:text-gray-800 hover:bg-black/[0.05] dark:hover:text-gray-200 dark:hover:bg-white/[0.07]"
    >
      <Icon size={12} className="flex-shrink-0" />
      {label}
    </button>
  );
}

// Section content in the selected view: folders (grouped by parent) or tree
// (full hierarchy). Both indent their rows under collapsible headers.
function SectionBody({ files, viewMode, foldSignal, handlers }) {
  if (viewMode === 'tree') {
    return <TreeView files={files} foldSignal={foldSignal} handlers={handlers} />;
  }
  return <FoldersView files={files} foldSignal={foldSignal} handlers={handlers} />;
}

// Folders view: flat groups keyed by each file's parent directory. Root-level
// files come first (no header); the rest are alphabetized, collapsible groups.
function FoldersView({ files, foldSignal, handlers }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const f of files) {
      const dir = dirOf(f.rel, f.name);
      if (!m.has(dir)) m.set(dir, []);
      m.get(dir).push(f);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return [...m.entries()].sort(([a], [b]) =>
      a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)
    );
  }, [files]);

  return (
    <>
      {groups.map(([dir, groupFiles]) =>
        dir === '' ? (
          groupFiles.map((f) => (
            <ChangeRow key={f.rel} file={f} hideDir handlers={handlers} />
          ))
        ) : (
          <FolderGroup
            key={dir}
            dir={dir}
            files={groupFiles}
            foldSignal={foldSignal}
            handlers={handlers}
          />
        )
      )}
    </>
  );
}

// One collapsible parent-directory group in folders view.
function FolderGroup({ dir, files, foldSignal, handlers }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (foldSignal.epoch === 0) return;
    setOpen(foldSignal.action === 'expand');
  }, [foldSignal]);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        title={dir}
        className="w-full flex items-center gap-1 pl-3 pr-3 py-0.5 text-[11.5px] text-gray-500 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        {open ? (
          <ChevronDown size={12} className="flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0" />
        )}
        <Folder size={13} className="text-[#5ac8fa] flex-shrink-0" />
        <span className="truncate">{dir}</span>
      </button>
      {open &&
        files.map((f) => (
          <ChangeRow key={f.rel} file={f} hideDir depth={1} handlers={handlers} />
        ))}
    </div>
  );
}

// Build a nested { name, dirs: Map, files: [] } tree from a flat file list.
function buildTree(files) {
  const root = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.rel.split('/');
    parts.pop(); // drop the basename
    let node = root;
    for (const seg of parts) {
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, { name: seg, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(seg);
    }
    node.files.push(f);
  }
  return root;
}

// Tree view: the full directory hierarchy, with single-child directory chains
// compressed into one row (e.g. wp-content/plugins/foo) to keep WP paths shallow.
function TreeView({ files, foldSignal, handlers }) {
  const root = useMemo(() => buildTree(files), [files]);
  const subdirs = [...root.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const rootFiles = [...root.files].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {subdirs.map((d) => (
        <TreeDir
          key={d.name}
          node={d}
          depth={0}
          foldSignal={foldSignal}
          handlers={handlers}
        />
      ))}
      {rootFiles.map((f) => (
        <ChangeRow key={f.rel} file={f} hideDir depth={0} handlers={handlers} />
      ))}
    </>
  );
}

// One directory node in tree view. Compresses single-child chains into its own
// label so a deep path renders as a single collapsible row.
function TreeDir({ node, depth, foldSignal, handlers }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (foldSignal.epoch === 0) return;
    setOpen(foldSignal.action === 'expand');
  }, [foldSignal]);

  let name = node.name;
  let cur = node;
  while (cur.files.length === 0 && cur.dirs.size === 1) {
    const [only] = cur.dirs.values();
    name = `${name}/${only.name}`;
    cur = only;
  }
  const subdirs = [...cur.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...cur.files].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        title={name}
        style={{ paddingLeft: 12 + depth * 12 }}
        className="w-full flex items-center gap-1 pr-3 py-0.5 text-[12px] text-gray-600 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        {open ? (
          <ChevronDown size={12} className="flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0" />
        )}
        <Folder size={13} className="text-[#5ac8fa] flex-shrink-0" />
        <span className="truncate">{name}</span>
      </button>
      {open && (
        <>
          {subdirs.map((d) => (
            <TreeDir
              key={d.name}
              node={d}
              depth={depth + 1}
              foldSignal={foldSignal}
              handlers={handlers}
            />
          ))}
          {files.map((f) => (
            <ChangeRow
              key={f.rel}
              file={f}
              hideDir
              depth={depth + 1}
              handlers={handlers}
            />
          ))}
        </>
      )}
    </div>
  );
}

// A single changed-file row: type icon, muted directory prefix, bold basename
// (with old→new for renames), +/- counts, and a colored status dot. Clicking
// opens the diff (including for deletions — all-red). On hover the counts/dot
// give way to stage/unstage/discard actions. `depth` indents under a header.
function ChangeRow({ file, hideDir, depth = 0, handlers }) {
  const meta = statusDot(file.status);
  const deleted = file.status === 'D';
  const untracked = file.status === '?';
  const dir = hideDir ? '' : dirOf(file.rel, file.name);
  const oldName = file.oldRel ? baseOf(file.oldRel) : null;

  const act = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div
      className="group/row relative hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
      onContextMenu={(e) => handlers?.onContext(e, file)}
    >
      <button
        onClick={() => handlers?.onOpen(file)}
        title={file.rel}
        style={{ paddingLeft: 12 + depth * 12 }}
        className="w-full flex items-center gap-1.5 pr-3 py-1 text-[12.5px] text-left"
      >
        <FileGlyph name={file.name} className="flex-shrink-0" />
        <span className="flex min-w-0 flex-1 items-baseline overflow-hidden">
          {dir && <span className="truncate text-gray-500">{dir}/</span>}
          {oldName && (
            <span className="truncate text-gray-400 flex-shrink-0">
              {oldName}
              <span className="px-1">→</span>
            </span>
          )}
          <span
            className={`min-w-[80px] truncate font-medium text-gray-800 ${
              deleted ? 'line-through' : ''
            }`}
          >
            {file.name}
          </span>
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0 group-hover/row:invisible">
          {(file.additions > 0 || file.deletions > 0) && (
            <span className="text-[10.5px] tabular-nums">
              {file.additions > 0 && (
                <span className="text-green-500 dark:text-green-400">+{file.additions}</span>
              )}
              {file.additions > 0 && file.deletions > 0 && ' '}
              {file.deletions > 0 && (
                <span className="text-red-500 dark:text-red-400">−{file.deletions}</span>
              )}
            </span>
          )}
          <span
            className={`w-2 h-2 rounded-full ${meta.cls}`}
            title={meta.label}
          />
        </span>
      </button>

      {/* Hover actions: stage (unstaged) / unstage (staged) + discard. */}
      <div className="absolute inset-y-0 right-2 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100">
        {file.source === 'unstaged' ? (
          <>
            <RowAction
              icon={Plus}
              label="Stage"
              onClick={act(() => handlers?.onStage(file.repoRoot, [file.rel]))}
            />
            <RowAction
              icon={untracked ? Trash2 : Undo2}
              label={untracked ? 'Delete' : 'Discard changes'}
              danger
              onClick={act(() => handlers?.onDiscard(file))}
            />
          </>
        ) : (
          <RowAction
            icon={Minus}
            label="Unstage"
            onClick={act(() => handlers?.onUnstage(file.repoRoot, [file.rel]))}
          />
        )}
      </div>
    </div>
  );
}

// A small square icon button for a Changes row's hover actions.
function RowAction({ icon: Icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex w-5 h-5 items-center justify-center rounded text-gray-500 hover:bg-black/10 dark:hover:bg-white/15 ${
        danger
          ? 'hover:text-red-600 dark:hover:text-red-400'
          : 'hover:text-gray-800 dark:hover:text-gray-100'
      }`}
    >
      <Icon size={13} className="flex-shrink-0" />
    </button>
  );
}
