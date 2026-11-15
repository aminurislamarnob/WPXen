import { useEffect, useRef, useState } from 'react';

// A Session's name as a text field: the tab label (tab menu → Rename) or a
// sidebar row (row menu → Rename), after Orca's Change Title. Enter or
// leaving the field saves, Escape cancels; saving it empty goes back to the
// automatic name.
export default function RenameInput({ initial, onCommit, onCancel, className = '' }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    // Saving the name it already had would pin the automatic name as a
    // custom one, so an unchanged field is a cancel.
    if (save && value.trim() !== initial.trim()) onCommit(value);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Session name"
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className={`form-input h-6 px-1.5 py-0 text-[13px] ${className || 'w-[160px]'}`}
    />
  );
}
