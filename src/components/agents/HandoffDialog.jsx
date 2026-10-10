import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui';
import { ProviderIcon } from '../providerIcons';

export default function HandoffDialog({ sessionId, onClose, onComplete }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [targetId, setTargetId] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let active = true;
    window.electronAPI
      .prepareHandoff(sessionId)
      .then((res) => {
        if (!active) return;
        if (res.error) {
          setError(res.error);
          setLoading(false);
        } else {
          setData(res);
          if (res.defaultAgentId) setTargetId(res.defaultAgentId);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  const handleRun = async () => {
    if (!targetId || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await window.electronAPI.runHandoff({
        sessionId,
        targetAgentId: targetId,
        mode: 'quick',
      });
      if (res.error) {
        setError(res.error);
        setRunning(false);
      } else {
        onComplete(res.sessionId);
      }
    } catch (err) {
      setError(err.message);
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="panel w-[400px] p-6 shadow-lg relative rounded-xl border border-border">
        <h2 className="text-[15px] font-semibold text-foreground mb-4">
          Hand Off Session
        </h2>

        {loading ? (
          <div className="flex justify-center p-4">
            <Loader2 className="animate-spin text-muted-foreground" size={24} />
          </div>
        ) : error && !data ? (
          <div className="text-destructive text-[13px]">{error}</div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-[13px] text-muted-foreground mb-2">
                Context source: <strong>Terminal capture</strong>
              </p>
              <label className="block text-[12.5px] text-foreground mb-1">
                Hand off to
              </label>
              {data.agents && data.agents.length > 0 ? (
                <div className="flex flex-col gap-1 border border-border rounded overflow-hidden">
                  {data.agents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setTargetId(a.id)}
                      className={`flex items-center gap-2 px-3 py-2 text-left text-[13px] ${
                        targetId === a.id
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                    >
                      <ProviderIcon agentId={a.id} size={16} />
                      {a.name}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  No installed agents available.
                </p>
              )}
            </div>

            {error && <div className="text-destructive text-[13px]">{error}</div>}

            <div className="flex justify-end gap-2 mt-6">
              <Button variant="secondary" onClick={onClose} disabled={running}>
                Cancel
              </Button>
              <Button onClick={handleRun} disabled={running || !targetId}>
                {running ? <Loader2 size={14} className="animate-spin" /> : null}
                Hand Off
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
