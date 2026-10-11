import { useState, useEffect } from 'react';

// A transcript image, fetched from the main process by its { uuid, path } ref.
export function ImageRef({ sessionId, refData }) {
  // Rows are replaced on every update; key the fetch on the ref's value, not
  // its identity, so a re-render doesn't rescan the transcript.
  const refKey = `${refData.uuid}:${refData.path.join('.')}`;
  const [dataUrl, setDataUrl] = useState(null);
  const [error, setError] = useState(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .chatImage(sessionId, refData)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setError('Image not found');
        } else if (res.tooLarge) {
          setError('Image too large to preview (over 5 MB)');
        } else {
          setDataUrl(res);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refKey is refData's value
  }, [sessionId, refKey]);

  if (error) {
    return (
      <div className="p-2 border rounded bg-muted/50 text-xs text-muted-foreground">
        {error}
      </div>
    );
  }
  if (!dataUrl) {
    return (
      <div className="p-2 border rounded bg-muted/50 text-xs animate-pulse">
        Loading image...
      </div>
    );
  }

  return (
    <>
      <img
        src={dataUrl}
        alt="User attachment"
        className="max-w-[200px] max-h-[200px] object-contain rounded border cursor-pointer hover:opacity-90"
        onClick={() => setIsOpen(true)}
      />
      {isOpen && (
        <div
          className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center p-8"
          onClick={() => setIsOpen(false)}
        >
          <img
            src={dataUrl}
            alt="User attachment full size"
            className="max-w-full max-h-full object-contain shadow-xl rounded"
          />
        </div>
      )}
    </>
  );
}
