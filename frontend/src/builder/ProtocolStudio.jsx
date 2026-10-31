import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../auth/AuthContext';
import useProtocolStore from './store';
import useProtocolMeta, { metaModeFor } from './useProtocolMeta';
import ToolPalette from './ToolPalette';
import HandWorkspace from './HandWorkspace';
import PropertiesPanel from './PropertiesPanel';
import ProtocolMetadataPanel from './ProtocolMetadataPanel';
import PreviewMode from './PreviewMode';
import StudioTopBar from './StudioTopBar';
import StudioBottomBar from './StudioBottomBar';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const fileSafe = (s) => String(s || 'protocol').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'protocol';

/**
 * The Protocol Studio: the authoring workspace for ONE protocol across all its views.
 *
 *  - markings are edited in the store and saved with ONE request (POST /api/protocols/:id/save) for every view;
 *  - protocol details (category, conditions, search terms, publishing, sharing) are available to the OWNING DOCTOR
 *    (owner-scoped /api/protocols/:id/... endpoints) and to admins (the /api/admin endpoints, which also keep version
 *    history and restore) — see useProtocolMeta;
 *  - the Studio only ever edits the DRAFT. Publishing goes through the existing publish endpoint; a published
 *    version is immutable and later edits simply become unpublished changes.
 */
export default function ProtocolStudio({ protocolId }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = Boolean(user) && user.role === 'admin';
  const metaMode = metaModeFor(user); // 'admin' | 'doctor' | null

  const protocol = useProtocolStore((s) => s.protocol);
  const loadProtocol = useProtocolStore((s) => s.loadProtocol);
  const reset = useProtocolStore((s) => s.reset);
  const save = useProtocolStore((s) => s.save);
  const isSaving = useProtocolStore((s) => s.isSaving);
  const isDirty = useProtocolStore((s) => s.isDirty);
  const saveMessage = useProtocolStore((s) => s.saveMessage);
  const error = useProtocolStore((s) => s.error);
  const selectedObjectId = useProtocolStore((s) => s.selectedObjectId);
  const undo = useProtocolStore((s) => s.undo);
  const redo = useProtocolStore((s) => s.redo);
  const copySelected = useProtocolStore((s) => s.copySelected);
  const pasteClipboard = useProtocolStore((s) => s.pasteClipboard);
  const duplicateSelected = useProtocolStore((s) => s.duplicateSelected);
  const deleteObject = useProtocolStore((s) => s.deleteObject);
  const setActiveTool = useProtocolStore((s) => s.setActiveTool);

  const [loadError, setLoadError] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const [tab, setTab] = useState('properties');
  const [preview, setPreview] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [focusedCanvasId, setFocusedCanvasId] = useState(null);
  const [notice, setNotice] = useState(null); // { kind: 'info' | 'error', text }
  const [importErrors, setImportErrors] = useState([]);
  const [assignEmail, setAssignEmail] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const fileInputRef = useRef(null);

  // Reloads the draft from the server (used after restoring a version).
  const reloadWorkingCopy = useCallback(async () => {
    const res = await api.get(`/protocols/${protocolId}`);
    loadProtocol(res.data);
    setNameDraft(res.data.name);
  }, [protocolId, loadProtocol]);

  const meta = useProtocolMeta(protocolId, Boolean(metaMode), { mode: metaMode || 'admin', onWorkingCopyChanged: reloadWorkingCopy });
  const hasChanges = isDirty || meta.dirty;

  // -- load ---------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/protocols/${protocolId}`)
      .then((res) => {
        if (cancelled) return;
        loadProtocol(res.data);
        setNameDraft(res.data.name);
      })
      .catch((err) => { if (!cancelled) setLoadError(err.message); });
    return () => {
      cancelled = true;
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocolId]);

  // Selecting an object brings the Properties tab forward.
  useEffect(() => { if (selectedObjectId) setTab('properties'); }, [selectedObjectId]);

  // Warn before the tab is closed with unsaved work.
  useEffect(() => {
    if (!hasChanges) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasChanges]);

  // Keyboard shortcuts. Ignored while typing in a field.
  const handleKeyDown = useCallback(
    (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && key === 'c') copySelected();
      else if (mod && key === 'v') pasteClipboard();
      else if (mod && key === 'd') { e.preventDefault(); duplicateSelected(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedObjectId) { e.preventDefault(); deleteObject(selectedObjectId); }
      else if (e.key === 'Escape') setActiveTool('select');
    },
    [undo, redo, copySelected, pasteClipboard, duplicateSelected, deleteObject, selectedObjectId, setActiveTool]
  );
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Updates only the protocol's own details in the store. (loadProtocol would also reset the canvases and undo
  // history, discarding unsaved markings.)
  const adoptProtocolDetails = (data) => useProtocolStore.setState({ protocol: data });

  // -- actions ---------------------------------------------------------------------
  const handleSave = async () => {
    setNotice(null);
    try {
      if (meta.dirty && !(await meta.saveMetadata())) return false;
      if (useProtocolStore.getState().isDirty) {
        await save();
        // markings changed on the server: refresh status / "unpublished changes" (keeps any unsaved detail edits)
        if (metaMode) await meta.reload();
      }
      return true;
    } catch (e) {
      return false; // the store already holds the message
    }
  };

  const handlePublish = async (note) => {
    const firstPublish = !(meta.meta && meta.meta.published);
    if (hasChanges && !window.confirm('Save your latest edits and publish them as a new version?')) return false;
    // a doctor publishing for the first time makes the protocol visible to anyone with its link: say so, never silently
    if (!hasChanges && !isAdmin && firstPublish && !window.confirm('Publish this protocol? Anyone with its link will be able to view it.')) return false;
    if (!(await handleSave())) return false;
    const result = await meta.publish(note);
    if (result !== null) {
      // keep the top bar in step with what the server now says (status + version), without touching the canvases
      const published = result.data && result.data.protocol;
      if (published) useProtocolStore.setState((s) => ({ protocol: { ...s.protocol, status: published.status, currentVersion: published.currentVersion } }));
      setNotice({ kind: 'info', text: 'Published. The published version is now frozen; further edits stay in the draft. Use the Share section below to copy the link or download the PDF.' });
    }
    return result !== null;
  };

  const handleRestore = async (version) => {
    const warning = hasChanges ? ' Unsaved edits on screen will be lost.' : '';
    if (!window.confirm(`Restore version ${version} into the draft?${warning}`)) return;
    if (await meta.restoreVersion(version)) setNotice({ kind: 'info', text: `Version ${version} restored into the draft.` });
  };

  const commitName = async () => {
    if (!protocol || !nameDraft.trim() || nameDraft === protocol.name) return;
    try {
      const res = await api.put(`/protocols/${protocol.id}`, { name: nameDraft.trim() });
      adoptProtocolDetails(res.data);
      if (metaMode) meta.reload();
    } catch (e) {
      setNotice({ kind: 'error', text: e.message });
    }
  };

  const handleDuplicate = async () => {
    if (isDirty && !window.confirm('Duplicate the last SAVED version? Unsaved edits on screen are not included.')) return;
    try {
      const res = await api.post(`/protocols/${protocol.id}/duplicate`);
      navigate(`/builder/${res.data.id}`);
    } catch (e) {
      setNotice({ kind: 'error', text: e.message });
    }
  };

  const handleExport = () => {
    const data = useProtocolStore.getState().exportProtocolData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileSafe(protocol.slug || protocol.name)}.protocol.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    setNotice(null);
    setImportErrors([]);
    if (file.size > MAX_IMPORT_BYTES) {
      setImportErrors([`file: is larger than ${MAX_IMPORT_BYTES / (1024 * 1024)} MB.`]);
      return;
    }
    let text;
    try { text = await file.text(); } catch (err) { setImportErrors(['file: could not be read.']); return; }
    const result = useProtocolStore.getState().importProtocolText(text);
    if (!result.ok) { setImportErrors(result.errors); return; }
    const count = result.views.reduce((n, v) => n + v.objects.length, 0);
    setNotice({ kind: 'info', text: `Imported ${count} object${count === 1 ? '' : 's'} across ${result.views.length} view${result.views.length === 1 ? '' : 's'}. Review them, then press Save Protocol. (Undo reverses the import.)` });
  };

  const handleLegacyStatus = async (status) => {
    try {
      const res = await api.put(`/protocols/${protocol.id}`, { status });
      adoptProtocolDetails(res.data);
      if (metaMode) meta.reload();
    } catch (e) {
      setNotice({ kind: 'error', text: e.message });
    }
  };

  const handleAssign = async (e) => {
    e.preventDefault();
    if (!assignEmail.trim()) return;
    setAssignBusy(true);
    try {
      const res = await api.post(`/protocols/${protocol.id}/assign`, { patientEmail: assignEmail.trim() });
      adoptProtocolDetails(res.data);
      setAssignEmail('');
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setAssignBusy(false);
    }
  };

  // -- render ---------------------------------------------------------------------
  if (loadError) {
    return (
      <div className="page-center">
        <div className="card">
          <h2>Couldn&apos;t load protocol</h2>
          <p>{loadError}</p>
          <Link to="/dashboard">Back to dashboard</Link>
        </div>
      </div>
    );
  }
  if (!protocol) return <div className="page-center">Loading protocol…</div>;

  const version = (meta.meta && meta.meta.currentVersion) || protocol.currentVersion;

  return (
    <div className="builder-page studio-page">
      <StudioTopBar
        protocol={protocol}
        version={version}
        nameDraft={nameDraft}
        onNameChange={setNameDraft}
        onNameCommit={commitName}
        message={saveMessage}
        error={error}
        isSaving={isSaving || meta.busy}
        canSave={hasChanges}
        hasChanges={hasChanges}
        onSave={handleSave}
        onPreview={() => setPreview(true)}
        onExport={handleExport}
        onImportClick={() => fileInputRef.current && fileInputRef.current.click()}
        onDuplicate={handleDuplicate}
      />

      {notice && (
        <div className={`studio-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          <button type="button" className="btn small" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {importErrors.length > 0 && (
        <div className="studio-notice error" role="alert">
          <div>
            <strong>Import failed — nothing was changed.</strong>
            <ul>{importErrors.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
          <button type="button" className="btn small" onClick={() => setImportErrors([])}>Dismiss</button>
        </div>
      )}

      {preview ? (
        <PreviewMode onExit={() => setPreview(false)} />
      ) : (
        <>
          <div className="studio-body">
            <ToolPalette />
            <HandWorkspace showGrid={showGrid} focusedCanvasId={focusedCanvasId} onFocusCanvas={setFocusedCanvasId} />
            <aside className="studio-sidebar">
              <div className="studio-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'properties'} className={tab === 'properties' ? 'active' : ''} onClick={() => setTab('properties')}>Properties</button>
                <button type="button" role="tab" aria-selected={tab === 'protocol'} className={tab === 'protocol' ? 'active' : ''} onClick={() => setTab('protocol')}>
                  Protocol{meta.dirty ? ' •' : ''}
                </button>
              </div>
              <div className="studio-sidebar-body">
                {tab === 'properties' ? (
                  <PropertiesPanel />
                ) : (
                  <>
                    <ProtocolMetadataPanel isAdmin={isAdmin} canManage={Boolean(metaMode)} meta={meta} onPublish={handlePublish} onRestore={handleRestore} onSave={handleSave} hasChanges={hasChanges} saving={isSaving || meta.busy} />
                    <details className="prop-group legacy">
                      <summary>Legacy options</summary>
                      <label className="field">
                        <span>Legacy status</span>
                        <select value={protocol.status} onChange={(e) => handleLegacyStatus(e.target.value)}>
                          <option value="draft">Draft</option>
                          <option value="active">Active (patient can start it)</option>
                          <option value="archived">Archived</option>
                        </select>
                      </label>
                      {protocol.patient ? (
                        <p className="muted small">Assigned to {protocol.patient.name} ({protocol.patient.email}){protocol.patient.status === 'pending' ? ' — pending signup' : ''}</p>
                      ) : (
                        <form className="inline-add" onSubmit={handleAssign}>
                          <input type="email" placeholder="Assign to patient email…" value={assignEmail} onChange={(e) => setAssignEmail(e.target.value)} />
                          <button className="btn small" type="submit" disabled={assignBusy}>{assignBusy ? '…' : 'Assign'}</button>
                        </form>
                      )}
                    </details>
                  </>
                )}
              </div>
            </aside>
          </div>
          <StudioBottomBar showGrid={showGrid} onToggleGrid={setShowGrid} />
        </>
      )}

      <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={handleImportFile} />
    </div>
  );
}
