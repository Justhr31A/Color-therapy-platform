import HandWorkspace from './HandWorkspace';

/** Read-only view of all four hands with their markings: no tools, no selection, nothing draggable. */
export default function PreviewMode({ onExit }) {
  return (
    <div className="studio-preview">
      <div className="preview-banner">
        <strong>Preview</strong>
        <span className="muted small">This is how the markings look on all four views. Editing is switched off.</span>
        <span className="topbar-spacer" />
        <button type="button" className="btn small" onClick={onExit}>Exit preview</button>
      </div>
      <HandWorkspace readOnly />
    </div>
  );
}
