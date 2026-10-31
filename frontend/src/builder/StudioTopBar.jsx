import { Link } from 'react-router-dom';

const STATUS_LABELS = { draft: 'Draft', in_review: 'In review', published: 'Published', archived: 'Archived', active: 'Active (legacy)' };

/** Protocol name / status / Save / Preview, plus import, export and duplicate. */
export default function StudioTopBar({
  protocol, version, nameDraft, onNameChange, onNameCommit, message, error, canSave, isSaving, hasChanges,
  onSave, onPreview, onExport, onImportClick, onDuplicate,
}) {
  return (
    <header className="builder-topbar studio-topbar">
      <Link to="/dashboard" className="back-link">← Dashboard</Link>
      <input className="protocol-name-input" aria-label="Protocol name" value={nameDraft} onChange={(e) => onNameChange(e.target.value)} onBlur={onNameCommit} />
      <span className="version-badge" title="Current draft version">v{version}</span>
      <span className={`pill ${protocol.status === 'published' ? 'status' : ''}`}>{STATUS_LABELS[protocol.status] || protocol.status}</span>
      <span className="pill">{protocol.protocolType === 'hand' ? 'Hand protocol' : 'Organ/Body protocol'}</span>
      <div className="topbar-spacer" />
      {message && <span className="save-message">{message}</span>}
      {error && <span className="save-error">{error}</span>}
      <button type="button" className="btn small" onClick={onImportClick} title="Replace the markings from a protocol JSON file">Import JSON</button>
      <button type="button" className="btn small" onClick={onExport} title="Download the markings as JSON">Export JSON</button>
      <button type="button" className="btn small" onClick={onDuplicate} title="Create a draft copy of this protocol">Duplicate protocol</button>
      <button type="button" className="btn small" onClick={onPreview}>Preview</button>
      <button type="button" className="btn primary" onClick={onSave} disabled={isSaving || !canSave}>
        {isSaving ? 'Saving…' : hasChanges ? 'Save Protocol' : 'Saved'}
      </button>
    </header>
  );
}
