import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { keymap } from '@codemirror/view';
import { oneDarkPro } from '../lib/oneDarkPro';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { Copy, ExternalLink, Save, X } from 'lucide-react';
import { FileGlyph } from '../lib/fileIcons';

// Pick CodeMirror language extensions from a file's extension.
function languageFor(name) {
  const base = name.toLowerCase();
  if (base === 'dockerfile') return [];
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'ts':
      return [javascript({ typescript: true })];
    case 'tsx':
      return [javascript({ jsx: true, typescript: true })];
    case 'json':
      return [json()];
    case 'css':
    case 'scss':
    case 'less':
      return [css()];
    case 'html':
    case 'htm':
    case 'xml':
    case 'vue':
    case 'svg':
      return [html()];
    case 'php':
      return [php()];
    case 'py':
      return [python()];
    case 'md':
    case 'markdown':
      return [markdown()];
    case 'yml':
    case 'yaml':
      return [yaml()];
    case 'sql':
      return [sql()];
    default:
      return [];
  }
}

// Editable, syntax-highlighted code editor (CodeMirror 6) with tabs, dirty
// tracking and save. Reads/writes files through the main process, confined to
// the site root. `files` is the open-tab list owned by the parent.
export default function CodeEditor({ rootPath, files, activePath, onSelect, onClose }) {
  // path -> { text, original } | { binary } | { tooLarge, size } | { error }
  const [cache, setCache] = useState({});
  const [saving, setSaving] = useState(false);

  const active = files.find((f) => f.path === activePath) || null;
  const data = activePath ? cache[activePath] : null;
  const editable = !!data && data.text !== undefined;
  const dirty = editable && data.text !== data.original;

  // Load the active file's contents on first open.
  useEffect(() => {
    if (!activePath || cache[activePath]) return;
    let cancelled = false;
    (async () => {
      const res = await window.electronAPI.readFile(rootPath, activePath);
      if (cancelled) return;
      const normalized =
        res?.content !== undefined
          ? { text: res.content, original: res.content }
          : res;
      setCache((prev) => ({ ...prev, [activePath]: normalized }));
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, rootPath, cache]);

  const onChange = useCallback(
    (value) => {
      setCache((prev) => {
        const cur = prev[activePath];
        if (!cur || cur.text === undefined) return prev;
        return { ...prev, [activePath]: { ...cur, text: value } };
      });
    },
    [activePath]
  );

  const save = useCallback(async () => {
    if (!activePath) return;
    const cur = cache[activePath];
    if (!cur || cur.text === undefined || cur.text === cur.original) return;
    setSaving(true);
    const res = await window.electronAPI.writeFile(rootPath, activePath, cur.text);
    setSaving(false);
    if (res?.error) {
      setCache((prev) => ({ ...prev, [activePath]: { ...prev[activePath], error: res.error } }));
      return;
    }
    setCache((prev) => {
      const c = prev[activePath];
      return { ...prev, [activePath]: { ...c, original: c.text, error: undefined } };
    });
  }, [activePath, rootPath, cache]);

  // Keep a stable ref so the Mod-s keymap always calls the latest save().
  const saveRef = useRef(save);
  saveRef.current = save;

  const requestClose = (path) => {
    const c = cache[path];
    if (c && c.text !== undefined && c.text !== c.original) {
      if (!window.confirm('Discard unsaved changes?')) return;
    }
    onClose(path);
  };

  const extensions = useMemo(() => {
    const base = [
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) }]),
    ];
    return active ? [...base, ...languageFor(active.name)] : base;
  }, [active]);

  return (
    <div className="h-full flex flex-col bg-[#282c34] text-[#abb2bf]">
      {/* Tab strip */}
      <div className="flex items-stretch h-9 bg-[#21252b] border-b border-black/40 overflow-x-auto flex-shrink-0">
        {files.map((f) => {
          const isActive = f.path === activePath;
          const isDirty =
            cache[f.path]?.text !== undefined &&
            cache[f.path].text !== cache[f.path].original;
          return (
            <div
              key={f.path}
              onClick={() => onSelect(f.path)}
              title={f.path}
              className={`group flex items-center gap-2 pl-3 pr-2 text-[12.5px] cursor-pointer border-r border-black/40 whitespace-nowrap ${
                isActive
                  ? 'bg-[#282c34] text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <FileGlyph name={f.name} size={13} className="flex-shrink-0" />
              <span className="truncate max-w-[160px]">{f.name}</span>
              {isDirty ? (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-zinc-300 group-hover:hidden flex-shrink-0"
                  title="Unsaved changes"
                />
              ) : null}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(f.path);
                }}
                className={`p-0.5 rounded hover:bg-white/15 text-zinc-500 hover:text-zinc-200 ${
                  isDirty ? 'hidden group-hover:block' : ''
                }`}
                title="Close"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {active && (
        <>
          {/* Header actions */}
          <div className="flex items-center justify-between h-8 px-3 border-b border-black/30 flex-shrink-0">
            <span className="text-[12px] text-zinc-400 truncate">
              {active.name}
              {dirty ? ' •' : ''}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
                title="Save (⌘S)"
                disabled={!dirty || saving}
                onClick={save}
              >
                <Save size={14} />
              </button>
              <button
                className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-white/10"
                title="Copy contents"
                onClick={() =>
                  editable && navigator.clipboard?.writeText(data.text)
                }
              >
                <Copy size={14} />
              </button>
              <button
                className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-white/10"
                title="Open in default app"
                onClick={() => window.electronAPI.openFilePath(active.path)}
              >
                <ExternalLink size={14} />
              </button>
              <button
                className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-white/10"
                title="Close"
                onClick={() => requestClose(active.path)}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Editor / status */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {!data ? (
              <div className="p-4 text-zinc-500 text-[12.5px]">Loading…</div>
            ) : data.tooLarge ? (
              <div className="p-4 text-zinc-500 text-[12.5px]">
                File is too large to edit ({Math.round(data.size / 1024)} KB).
              </div>
            ) : data.binary ? (
              <div className="p-4 text-zinc-500 text-[12.5px]">
                Binary file — cannot edit.
              </div>
            ) : (
              <>
                {data.error && (
                  <div className="px-3 py-1 text-[11px] text-red-400 border-b border-white/10">
                    {data.error}
                  </div>
                )}
                <CodeMirror
                  value={data.text}
                  height="100%"
                  theme={oneDarkPro}
                  extensions={extensions}
                  onChange={onChange}
                  className="flex-1 min-h-0 text-[12.5px]"
                  basicSetup={{ tabSize: 2 }}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
