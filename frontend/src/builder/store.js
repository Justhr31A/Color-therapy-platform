import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import api from '../api/client';
import { createStudioObject, offsetForCopy, syncDerivedMetadata, deepClone } from './model/objectModel';
import { buildExport, validateImport } from './model/importExport';

const HISTORY_LIMIT = 100;

function cloneCanvases(canvases) {
  return canvases.map((c) => ({ ...c, objects: c.objects.map((o) => deepCloneObject(o)) }));
}

/**
 * A real deep clone (not a shallow `{...o}` spread) for a single protocol
 * object. Matters for everything nested inside an object — `points` (free
 * line), `metadata` (size/scale presets, the ring of a Dot + Ring, a Finger
 * Band's data, text) and `landmarkReference`: a shallow spread would leave
 * those pointing at the exact same reference as the source, so editing a copy
 * would silently edit the original. Cloning properly costs nothing.
 */
function deepCloneObject(o) {
  return deepClone(o);
}

/** Every object id is unique across the whole protocol, so an object can be found without knowing its view. */
function findCanvasIdOf(canvases, objectId) {
  const owner = canvases.find((c) => c.objects.some((o) => o.id === objectId));
  return owner ? owner.id : null;
}

function withObjectAdded(canvases, canvasId, object) {
  return canvases.map((c) => (c.id === canvasId ? { ...c, objects: [...c.objects, object] } : c));
}

const ctxFor = (canvas) => ({ viewKey: canvas.viewKey, canvasWidth: canvas.width, canvasHeight: canvas.height });

const useProtocolStore = create((set, get) => ({
  protocol: null,
  canvases: [],
  activeCanvasId: null,
  activeTool: 'select',
  selectedObjectId: null,
  clipboard: null,

  history: { past: [], future: [] },
  isDirty: false,
  isSaving: false,
  isLoading: false,
  error: null,
  saveMessage: null,

  // -- loading -------------------------------------------------------------
  loadProtocol(protocol) {
    set({
      protocol,
      canvases: cloneCanvases(protocol.canvases),
      activeCanvasId: protocol.canvases[0]?.id || null,
      activeTool: 'select',
      selectedObjectId: null,
      clipboard: null,
      history: { past: [], future: [] },
      isDirty: false,
      error: null,
      saveMessage: null,
    });
  },

  reset() {
    set({
      protocol: null,
      canvases: [],
      activeCanvasId: null,
      selectedObjectId: null,
      history: { past: [], future: [] },
    });
  },

  // -- selectors -------------------------------------------------------------
  getActiveCanvas() {
    const { canvases, activeCanvasId } = get();
    return canvases.find((c) => c.id === activeCanvasId) || null;
  },

  /** The selected object, from whichever view it lives in (the active view is looked at first). */
  getSelectedObject() {
    const { canvases, activeCanvasId, selectedObjectId } = get();
    if (!selectedObjectId) return null;
    const active = canvases.find((c) => c.id === activeCanvasId);
    const inActive = active && active.objects.find((o) => o.id === selectedObjectId);
    if (inActive) return inActive;
    for (const c of canvases) {
      const found = c.objects.find((o) => o.id === selectedObjectId);
      if (found) return found;
    }
    return null;
  },

  /** The view (canvas) the selected object belongs to. */
  getSelectedCanvas() {
    const { canvases, selectedObjectId } = get();
    return canvases.find((c) => c.objects.some((o) => o.id === selectedObjectId)) || null;
  },

  // -- navigation -------------------------------------------------------------
  setActiveCanvas(id) {
    set({ activeCanvasId: id, selectedObjectId: null, activeTool: 'select' });
  },

  /**
   * Makes a view the working view WITHOUT changing the tool. Used when the doctor interacts with one of
   * the four visible views: a selection that belongs to another view is dropped.
   */
  focusCanvas(id) {
    const { activeCanvasId, canvases, selectedObjectId } = get();
    if (id === activeCanvasId) return;
    const stillHere = canvases.find((c) => c.id === id)?.objects.some((o) => o.id === selectedObjectId);
    set({ activeCanvasId: id, selectedObjectId: stillHere ? selectedObjectId : null });
  },

  setActiveTool(tool) {
    set({ activeTool: tool, selectedObjectId: null });
  },

  /** Selecting an object also makes its view the active one. `canvasId` is optional (found from the object if omitted). */
  selectObject(id, canvasId) {
    if (id === null || id === undefined) {
      set({ selectedObjectId: null, activeTool: 'select' });
      return;
    }
    const owner = canvasId || findCanvasIdOf(get().canvases, id) || get().activeCanvasId;
    set({ selectedObjectId: id, activeCanvasId: owner, activeTool: 'select' });
  },

  // -- history -------------------------------------------------------------
  _pushHistory() {
    const { canvases, history } = get();
    const past = [...history.past, cloneCanvases(canvases)].slice(-HISTORY_LIMIT);
    set({ history: { past, future: [] } });
  },

  undo() {
    const { history, canvases } = get();
    if (!history.past.length) return;
    const previous = history.past[history.past.length - 1];
    const past = history.past.slice(0, -1);
    const future = [cloneCanvases(canvases), ...history.future];
    set({ canvases: previous, history: { past, future }, isDirty: true, selectedObjectId: null });
  },

  redo() {
    const { history, canvases } = get();
    if (!history.future.length) return;
    const next = history.future[0];
    const future = history.future.slice(1);
    const past = [...history.past, cloneCanvases(canvases)];
    set({ canvases: next, history: { past, future }, isDirty: true, selectedObjectId: null });
  },

  canUndo() {
    return get().history.past.length > 0;
  },
  canRedo() {
    return get().history.future.length > 0;
  },

  // -- object mutation (every one of these is a single undoable step) --------
  /**
   * Adds the object for the active drawing tool to `canvasId` (default: the active view). With four views
   * on screen the click may land on any of them, so the view is passed explicitly.
   */
  addObjectAtPoint(x, y, canvasId) {
    const { activeTool, canvases } = get();
    const targetId = canvasId || get().activeCanvasId;
    if (activeTool === 'select' || activeTool === 'eraser' || !targetId) return;
    const canvas = canvases.find((c) => c.id === targetId);
    if (!canvas) return;
    const newObject = createStudioObject(activeTool, x, y, ctxFor(canvas));
    if (!newObject) return; // e.g. a Finger Band on a view that has no finger guides
    get()._pushHistory();
    set({
      canvases: withObjectAdded(canvases, targetId, newObject),
      activeCanvasId: targetId,
      isDirty: true,
      selectedObjectId: newObject.id,
      activeTool: 'select',
    });
  },

  /** Commits a completed free-line drag (mouse down → move → up) as one object. */
  addFreeLineAtPoints(points, canvasId) {
    const { canvases } = get();
    const targetId = canvasId || get().activeCanvasId;
    if (!targetId || points.length < 2) return;
    const canvas = canvases.find((c) => c.id === targetId);
    if (!canvas) return;
    get()._pushHistory();
    const newObject = createStudioObject('freeline', points[0].x, points[0].y, ctxFor(canvas));
    newObject.points = points;
    set({
      canvases: withObjectAdded(canvases, targetId, newObject),
      activeCanvasId: targetId,
      isDirty: true,
      selectedObjectId: newObject.id,
      activeTool: 'select',
    });
  },

  /**
   * Commit a finished change (drag end, transform end, or a panel edit). The object is found in whichever
   * view it lives in. Afterwards the recorded intent (scale, thicknessScale, ring scales) is re-derived from
   * the real geometry so a canvas resize can never leave a stale value behind.
   */
  commitObjectChange(objectId, patch, canvasId) {
    const { activeCanvasId, canvases } = get();
    const owner = canvasId || findCanvasIdOf(canvases, objectId) || activeCanvasId;
    get()._pushHistory();
    const nextCanvases = canvases.map((c) =>
      c.id === owner
        ? { ...c, objects: c.objects.map((o) => (o.id === objectId ? syncDerivedMetadata({ ...o, ...patch }) : o)) }
        : c
    );
    set({ canvases: nextCanvases, isDirty: true });
  },

  deleteObject(objectId, canvasId) {
    const { activeCanvasId, canvases, selectedObjectId } = get();
    const owner = canvasId || findCanvasIdOf(canvases, objectId) || activeCanvasId;
    get()._pushHistory();
    const nextCanvases = canvases.map((c) =>
      c.id === owner ? { ...c, objects: c.objects.filter((o) => o.id !== objectId) } : c
    );
    set({
      canvases: nextCanvases,
      isDirty: true,
      selectedObjectId: selectedObjectId === objectId ? null : selectedObjectId,
    });
  },

  copySelected() {
    const selected = get().getSelectedObject();
    if (!selected) return;
    const { id, ...withoutId } = deepCloneObject(selected);
    set({ clipboard: withoutId });
  },

  /** Pastes onto the ACTIVE view (which may differ from the view it was copied from). */
  pasteClipboard() {
    const { clipboard, activeCanvasId, canvases } = get();
    if (!clipboard || !activeCanvasId) return;
    const canvas = canvases.find((c) => c.id === activeCanvasId);
    if (!canvas) return;
    get()._pushHistory();
    const copy = deepCloneObject(clipboard);
    const pasted = {
      ...copy,
      ...offsetForCopy(copy, { viewKey: canvas.viewKey, canvas }),
      id: uuidv4(),
      zIndex: Date.now(),
    };
    set({ canvases: withObjectAdded(canvases, activeCanvasId, pasted), isDirty: true, selectedObjectId: pasted.id });
  },

  /** Duplicates the selected object into the SAME view, with a new id and no shared nested data. */
  duplicateSelected() {
    const selected = get().getSelectedObject();
    if (!selected) return;
    const { canvases } = get();
    const owner = canvases.find((c) => c.objects.some((o) => o.id === selected.id));
    if (!owner) return;
    get()._pushHistory();
    const copy = deepCloneObject(selected);
    const duplicate = {
      ...copy,
      ...offsetForCopy(copy, { viewKey: owner.viewKey, canvas: owner }),
      id: uuidv4(),
      zIndex: Date.now(),
    };
    set({ canvases: withObjectAdded(canvases, owner.id, duplicate), isDirty: true, selectedObjectId: duplicate.id });
  },

  // -- import / export -----------------------------------------------------------
  /** The protocol's markings as structured JSON data (all views). */
  exportProtocolData() {
    const { protocol, canvases } = get();
    return buildExport(protocol, canvases);
  },

  /**
   * Replaces the objects of the views present in `data` (validated first; new object ids are assigned) as ONE
   * undoable step. Returns { ok, errors } and never throws; on failure nothing changes.
   */
  importProtocolData(data) {
    const { canvases } = get();
    const result = validateImport(data, canvases);
    if (!result.ok) return result;
    get()._pushHistory();
    const byCanvas = new Map(result.views.map((v) => [v.canvasId, v.objects]));
    set({
      canvases: canvases.map((c) => (byCanvas.has(c.id) ? { ...c, objects: byCanvas.get(c.id) } : c)),
      isDirty: true,
      selectedObjectId: null,
      activeTool: 'select',
    });
    return result;
  },

  /** Same, from the raw text of a file. */
  importProtocolText(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, errors: ['file: is not valid JSON.'], views: [] };
    }
    return get().importProtocolData(data);
  },

  // -- persistence -------------------------------------------------------------
  async save() {
    const { protocol, canvases } = get();
    if (!protocol) return;
    set({ isSaving: true, error: null, saveMessage: null });
    try {
      // ONE request persists the whole protocol: every view and every object in it.
      const payload = {
        canvases: canvases.map((c) => ({ id: c.id, objects: c.objects })),
      };
      const res = await api.post(`/protocols/${protocol.id}/save`, payload);
      // Adopt the server's response as the new source of truth (not just for
      // `protocol` metadata like currentVersion, but for `canvases` too) so
      // "what's on screen after a save" is always provably what the database
      // actually holds, rather than relying on the assumption that the echo
      // matches what we sent.
      set({
        protocol: res.data,
        canvases: cloneCanvases(res.data.canvases),
        isDirty: false,
        isSaving: false,
        saveMessage: 'Protocol saved successfully.',
      });
      return res.data;
    } catch (err) {
      set({ isSaving: false, error: err.message });
      throw err;
    }
  },
}));

export default useProtocolStore;
