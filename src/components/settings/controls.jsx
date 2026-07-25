import { useEffect, useRef, useState } from 'react';

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
