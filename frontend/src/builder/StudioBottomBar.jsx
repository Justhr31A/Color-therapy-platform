import useProtocolStore from './store';

/** Undo / redo, copy / paste / duplicate / delete, and the workspace display options. */
export default function StudioBottomBar({ showGrid, onToggleGrid }) {
  const undo = useProtocolStore((s) => s.undo);
  const redo = useProtocolStore((s) => s.redo);
  const canUndo = useProtocolStore((s) => s.history.past.length > 0);
  const canRedo = useProtocolStore((s) => s.history.future.length > 0);
  const copySelected = useProtocolStore((s) => s.copySelected);
  const pasteClipboard = useProtocolStore((s) => s.pasteClipboard);
  const duplicateSelected = useProtocolStore((s) => s.duplicateSelected);
  const deleteObject = useProtocolStore((s) => s.deleteObject);
  const selectedObjectId = useProtocolStore((s) => s.selectedObjectId);
  const clipboard = useProtocolStore((s) => s.clipboard);

  return (
    <footer className="studio-bottombar">
      <button type="button" className="btn small" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">↶ Undo</button>
      <button type="button" className="btn small" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)">↷ Redo</button>
      <span className="bar-divider" />
      <button type="button" className="btn small" disabled={!selectedObjectId} onClick={copySelected} title="Copy (Ctrl+C)">Copy</button>
      <button type="button" className="btn small" disabled={!clipboard} onClick={pasteClipboard} title="Paste onto the active view (Ctrl+V)">Paste</button>
      <button type="button" className="btn small" disabled={!selectedObjectId} onClick={duplicateSelected} title="Duplicate (Ctrl+D)">Duplicate</button>
      <button type="button" className="btn small danger" disabled={!selectedObjectId} onClick={() => deleteObject(selectedObjectId)} title="Delete (Del)">Delete</button>
      <span className="topbar-spacer" />
      <label className="check">
        <input type="checkbox" checked={showGrid} onChange={(e) => onToggleGrid(e.target.checked)} />
        <span>Grid (not saved)</span>
      </label>
    </footer>
  );
}
