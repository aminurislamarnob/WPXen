import { useCallback, useState } from 'react';

// Runs one of the issue writes exposed on window.electronAPI (tasksIssueState,
// tasksIssueAssignees…) and tracks it: `busy` while it runs, and the error
// message when it fails. Resolves the result, or null on failure — so a
// caller keeps its draft and shows `error` rather than losing what was typed.
export function useIssueMutation() {
  const [busy, setBusy] = useState(null); // the method name while one runs
  const [error, setError] = useState(null);

  const run = useCallback(async (method, opts) => {
    setBusy(method);
    setError(null);
    try {
      const res = await window.electronAPI[method](opts);
      if (!res || res.error) {
        setError(res?.error?.message || 'GitHub didn’t accept the change.');
        return null;
      }
      return res;
    } finally {
      setBusy(null);
    }
  }, []);

  return { run, busy, error, clearError: () => setError(null) };
}
