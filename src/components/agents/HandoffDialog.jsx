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
  const [primaryMode, setPrimaryMode] = useState('quick');
  const [quickMode, setQuickMode] = useState('focused');
  const [summaryPhase, setSummaryPhase] = useState(null);
  const [handoffId, setHandoffId] = useState(null);

  useEffect(() => {
    if (!handoffId) return;
    return window.electronAPI.onHandoffProgress((info) => {
      if (info.handoffId !== handoffId) return;
      if (info.phase === 'complete' && info.error) {
        // The summary is written; only the target failed to start.
        setSummaryPhase(null);
        setRunning(false);
        setError(info.error);
        return;
      }
      setSummaryPhase(info.phase);
      if (info.phase === 'complete') onComplete(info.sessionId);
    });
  }, [handoffId, onComplete]);

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
      const modeToRun =
        primaryMode === 'summarized'
          ? 'summarized'
          : data.contextSource === 'transcript'
            ? quickMode
            : 'quick';
      const res = await window.electronAPI.runHandoff({
        sessionId,
        targetAgentId: targetId,
        mode: modeToRun,
      });
      if (res.error) {
        setError(res.error);
        setRunning(false);
      } else {
        if (primaryMode === 'summarized') {
          setHandoffId(res.handoffId);
          setSummaryPhase('prompted');
        } else {
          onComplete(res.sessionId);
        }
      }
    } catch (err) {
      setError(err.message);
      setRunning(false);
    }
  };

  const handleCancelSummary = () => {
    if (handoffId) {
      window.electronAPI.cancelHandoffSummary(handoffId);
    }
  };

  // Closing the dialog mid-summary stops waiting; nothing launches later.
  const close = () => {
    if (handoffId && summaryPhase === 'prompted') handleCancelSummary();
    onClose();
  };

  const showFallback = summaryPhase === 'timeout' || summaryPhase === 'cancelled';
  const isWaiting = summaryPhase && !showFallback && summaryPhase !== 'complete';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="panel w-[450px] p-6 shadow-lg relative rounded-xl border border-border">
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
            {isWaiting ? (
              <div className="flex flex-col items-center justify-center py-6">
                <Loader2 className="animate-spin text-muted-foreground mb-4" size={32} />
                <p className="text-[13px] text-foreground mb-6">
                  Waiting for agent to write the handoff...
                </p>
                <Button variant="secondary" onClick={handleCancelSummary}>
                  Cancel
                </Button>
              </div>
            ) : showFallback ? (
              <div className="flex flex-col items-center justify-center py-6">
                <p className="text-[13px] text-foreground mb-4">
                  {summaryPhase === 'timeout'
                    ? 'Summary timed out.'
                    : 'Summary cancelled.'}
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={close}>
                    Close
                  </Button>
                  <Button
                    onClick={() => {
                      setPrimaryMode('quick');
                      setSummaryPhase(null);
                      setHandoffId(null);
                      setRunning(false);
                    }}
                  >
                    Use Quick instead
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-3 mb-4">
                  <label
                    className={`flex items-start gap-2 ${data.summarizeEnabled ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
                  >
                    <input
                      type="radio"
                      name="primaryMode"
                      className="mt-1"
                      checked={primaryMode === 'summarized'}
                      disabled={!data.summarizeEnabled}
                      onChange={() => setPrimaryMode('summarized')}
                    />
                    <div>
                      <div className="text-[13px] text-foreground font-medium">
                        Summarised by current Agent
                      </div>
                      <div className="text-[12px] text-muted-foreground">
                        {data.summarizeEnabled
                          ? 'The agent writes a curated handoff document itself.'
                          : data.summarizeDisabledReason}
                      </div>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="primaryMode"
                      className="mt-1"
                      checked={primaryMode === 'quick'}
                      onChange={() => setPrimaryMode('quick')}
                    />
                    <div>
                      <div className="text-[13px] text-foreground font-medium">
                        Quick (uses{' '}
                        {data.contextSource === 'transcript'
                          ? 'Transcript'
                          : 'Terminal capture'}
                        )
                      </div>
                      <div className="text-[12px] text-muted-foreground mb-2">
                        Passes the existing context directly.
                      </div>

                      {primaryMode === 'quick' && data.contextSource === 'transcript' && (
                        <div className="ml-2 pl-3 border-l border-border space-y-2 mt-2">
                          <label className="flex items-start gap-2 cursor-pointer group">
                            <input
                              type="radio"
                              name="quickMode"
                              className="mt-0.5"
                              checked={quickMode === 'focused'}
                              onChange={() => setQuickMode('focused')}
                            />
                            <div>
                              <div className="text-[12.5px] text-foreground font-medium">
                                Focused (Default)
                              </div>
                              <div className="text-[11.5px] text-muted-foreground">
                                Read only the sections needed.
                              </div>
                            </div>
                          </label>
                          <label className="flex items-start gap-2 cursor-pointer group">
                            <input
                              type="radio"
                              name="quickMode"
                              className="mt-0.5"
                              checked={quickMode === 'full'}
                              onChange={() => setQuickMode('full')}
                            />
                            <div>
                              <div className="text-[12.5px] text-foreground font-medium">
                                Full
                              </div>
                              <div className="text-[11.5px] text-muted-foreground">
                                Read the whole transcript first.
                              </div>
                            </div>
                          </label>
                        </div>
                      )}
                    </div>
                  </label>
                </div>

                <label className="block text-[12.5px] text-foreground mb-1">
                  Hand off to
                </label>
                {data.agents && data.agents.length > 0 ? (
                  <div className="flex flex-col gap-1 border border-border rounded overflow-hidden max-h-[150px] overflow-y-auto">
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

                {error && (
                  <div className="text-destructive text-[13px] mt-2">{error}</div>
                )}

                <div className="flex justify-end gap-2 mt-6">
                  <Button variant="secondary" onClick={close} disabled={running}>
                    Cancel
                  </Button>
                  <Button onClick={handleRun} disabled={running || !targetId}>
                    {running && !handoffId ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : null}
                    Hand Off
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
