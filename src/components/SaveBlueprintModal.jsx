import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, Loader, Layers } from 'lucide-react';
import { ProgressLog } from './ui';

export default function SaveBlueprintModal({ site, onClose, onSaved }) {
  const [name, setName] = useState(`${site.name} blueprint`);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('form'); // form | saving | done
  const [progressMessages, setProgressMessages] = useState([]);

  useEffect(() => {
    window.electronAPI.on('blueprint-save-progress', ({ message }) => {
      setProgressMessages((prev) => [...prev, message]);
    });
    return () => window.electronAPI.off('blueprint-save-progress');
  }, []);

  async function handleSave() {
    setError('');
    if (!name.trim()) return setError('Give the blueprint a name.');
    setPhase('saving');
    setProgressMessages(['Starting…']);
    const result = await window.electronAPI.saveBlueprint(site.id, {
      name: name.trim(),
      description: description.trim(),
    });
    if (result.success) {
      setProgressMessages((prev) => [...prev, 'Blueprint saved.']);
      setPhase('done');
      onSaved?.(result.blueprint);
    } else {
      setError(result.error || 'Failed to save blueprint.');
      setPhase('form');
    }
  }

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && phase !== 'saving' && onClose()}
    >
      <div className="sheet w-[520px] max-h-[90vh] overflow-hidden animate-slide-in">
        <div className="px-6 pt-6">
          <h2 className="text-[15px] font-bold text-foreground">Save as Blueprint</h2>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            Snapshot <span className="font-semibold">{site.name}</span> to spin up new
            sites from it later
          </p>
        </div>

        <div className="px-6 pt-4 pb-6">
          {phase === 'form' && (
            <div className="sheet-well space-y-4 animate-fade-in">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Blueprint Name
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Description <span className="text-muted-foreground">(optional)</span>
                </label>
                <textarea
                  className="form-input resize-none"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What's in this blueprint (plugins, theme, sample content)…"
                />
              </div>
              <div className="bg-highlight/10 rounded-xl px-4 py-3 text-xs text-highlight">
                A full snapshot (files + database) is saved. New sites created from this
                blueprint inherit its content and users.
              </div>
            </div>
          )}

          {(phase === 'saving' || phase === 'done') && (
            <div className="sheet-well animate-fade-in">
              {phase === 'done' ? (
                <div className="text-center py-4">
                  <div className="w-14 h-14 rounded-full bg-status-running/10 flex items-center justify-center mx-auto mb-3">
                    <CheckCircle size={28} className="text-status-running" />
                  </div>
                  <h3 className="text-base font-bold text-foreground">
                    Blueprint Saved!
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1 mb-4">
                    Create sites from it via <span className="font-medium">Add Site</span>
                    .
                  </p>
                  <button onClick={onClose} className="btn-primary">
                    Done
                  </button>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <Loader
                      size={18}
                      className="animate-spin text-highlight flex-shrink-0"
                    />
                    <p className="text-sm font-medium text-foreground">
                      Saving blueprint…
                    </p>
                  </div>
                  <ProgressLog messages={progressMessages} className="mt-4" />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 bg-destructive/10 text-destructive rounded-xl px-4 py-3 text-sm">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {phase === 'form' && (
          <div className="flex justify-end gap-2 px-6 pb-6">
            <button onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button onClick={handleSave} className="btn-primary">
              <Layers size={12} strokeWidth={2.5} />
              Save Blueprint
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
