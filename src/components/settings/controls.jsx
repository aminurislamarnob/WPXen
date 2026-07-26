import { useEffect, useRef, useState } from 'react';

// Dropdown bound to a setting. Enums commit immediately — there's no partial
// state to protect the way there is with a half-typed string.
export function SelectSetting({ value, onChange, options, ariaLabel, className = '' }) {
  return (
    <select
      aria-label={ariaLabel}
      className={`form-input !text-xs !py-1 ${className}`.trim()}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// Whole-number field bound to a setting. Commits on blur/Enter like TextSetting,
// and refuses to send a non-number so the main process never has to reject one.
export function NumberSetting({ value, onCommit, min, max, ariaLabel, className = '' }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const committed = useRef(String(value ?? ''));

  useEffect(() => {
    if (draft === committed.current) setDraft(String(value ?? ''));
    committed.current = String(value ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commit() {
    if (draft === committed.current) return;
    const parsed = Number(draft);
    if (!Number.isInteger(parsed)) {
      setDraft(committed.current);
      return;
    }
    committed.current = draft;
    onCommit(parsed);
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      aria-label={ariaLabel}
      className={`form-input font-mono !text-xs ${className}`.trim()}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setDraft(committed.current);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

// Slider bound to a setting.
//
// For the same reason TextSetting doesn't save per keystroke, this doesn't save
// per pixel: a drag fires a change event per step, and each one would be an IPC
// round trip plus a full rewrite of the JSON store — and, for typography, a
// refit of every live terminal. The slider therefore tracks a local draft while
// the pointer is down and commits once on release.
//
// `onPreview` lets a caller mirror the in-flight value (a live font preview)
// without paying for a write; the readout beside the slider always shows it.
export function RangeSetting({
  value,
  onCommit,
  onPreview,
  min,
  max,
  step,
  ariaLabel,
  format = (v) => v,
}) {
  const [draft, setDraft] = useState(null); // non-null only mid-drag
  const shown = draft === null ? value : draft;

  // The committed value arriving back as a prop ends the drag. Nothing else
  // changes `value` while the pointer is down, so this can't fight the drag.
  useEffect(() => {
    setDraft(null);
  }, [value]);

  function commit() {
    if (draft === null) return;
    if (draft === value) setDraft(null);
    else onCommit(draft);
  }

  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        value={shown}
        onChange={(e) => {
          const next = Number(e.target.value);
          setDraft(next);
          onPreview?.(next);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-40 accent-highlight"
      />
      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
        {format(shown)}
      </span>
    </>
  );
}

// Text field bound to a setting.
//
// Auto-save doesn't mean save-per-keystroke: that would write the store (and
// re-init the MySQL client) on every character. Text commits on blur and on
// Enter, which is what Superset's model settings do. Escape reverts.
export function TextSetting({
  value,
  onCommit,
  type = 'text',
  className = '',
  placeholder,
  ariaLabel,
  disabled,
}) {
  const [draft, setDraft] = useState(value ?? '');
  const committed = useRef(value ?? '');

  // Adopt external changes (another window, a rollback) unless the user is
  // mid-edit on this field.
  useEffect(() => {
    if (draft === committed.current) {
      setDraft(value ?? '');
    }
    committed.current = value ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commit() {
    if (draft === committed.current) return;
    committed.current = draft;
    onCommit(draft);
  }

  return (
    <input
      type={type}
      aria-label={ariaLabel}
      className={`form-input ${className}`.trim()}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(committed.current);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
