import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client';

const FIELDS = ['displayName', 'shortDescription', 'description', 'categoryId'];
const toDraft = (p) => ({
  displayName: p.displayName || '',
  shortDescription: p.shortDescription || '',
  description: p.description || '',
  categoryId: p.categoryId || '',
});

/** Which API the Protocol tab uses for this user: 'admin', 'doctor', or null (no access — patients never reach the Studio). */
export function metaModeFor(user) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  if (user.role === 'doctor') return 'doctor';
  return null;
}

/**
 * Every endpoint the Protocol tab calls, in ONE place (relative to the axios client's /api base).
 *
 *  - 'admin'  : the existing /api/admin endpoints — unchanged.
 *  - 'doctor' : the owner-scoped endpoints under /api/protocols/:id (the server answers 404 for a protocol that is
 *               not yours) plus the read-only /api/catalog. A doctor has no version history / restore / archive /
 *               status endpoints (those stay admin-only), so none are listed.
 *
 * Both modes publish through an existing publish endpoint; there is no second one.
 */
export function metaEndpoints(mode, protocolId) {
  if (mode === 'doctor') {
    return {
      details: `/protocols/${protocolId}/details`,
      categories: '/catalog/categories',
      conditions: '/catalog/conditions',
      versions: null,
      saveDetails: `/protocols/${protocolId}/details`,
      searchTerms: `/protocols/${protocolId}/search-terms`,
      searchTerm: (termId) => `/protocols/${protocolId}/search-terms/${termId}`,
      attach: (conditionId) => ({ url: `/protocols/${protocolId}/conditions`, body: { conditionId } }),
      detach: (conditionId) => `/protocols/${protocolId}/conditions/${conditionId}`,
      publish: `/protocols/${protocolId}/publish`,
    };
  }
  return {
    details: `/admin/protocols/${protocolId}`,
    categories: '/admin/categories',
    conditions: '/admin/conditions',
    versions: `/admin/protocols/${protocolId}/versions`,
    saveDetails: `/admin/protocols/${protocolId}`,
    searchTerms: `/admin/protocols/${protocolId}/search-terms`,
    searchTerm: (termId) => `/admin/protocols/${protocolId}/search-terms/${termId}`,
    attach: (conditionId) => ({ url: `/admin/conditions/${conditionId}/protocols`, body: { protocolId } }),
    detach: (conditionId) => `/admin/conditions/${conditionId}/protocols/${protocolId}`,
    publish: `/admin/protocols/${protocolId}/publish`,
  };
}

/**
 * Protocol metadata for the Studio's "Protocol" tab (nothing is stored in the browser). Holds the server copy plus
 * an editable draft, and wraps every mutation so the panel just calls an action and re-renders.
 *
 * `mode` is 'admin' or 'doctor' (see metaEndpoints). Creating categories/conditions, status changes, archiving and
 * restoring versions exist only in admin mode; in doctor mode they refuse with a message instead of calling the server.
 *
 * `onWorkingCopyChanged` is called after an action that changed the DRAFT canvases on the server (restoring a
 * version), so the Studio can reload them.
 */
export default function useProtocolMeta(protocolId, enabled, { mode = 'admin', onWorkingCopyChanged } = {}) {
  const [meta, setMeta] = useState(null);
  const [draft, setDraft] = useState(null);
  const [categories, setCategories] = useState([]);
  const [conditions, setConditions] = useState([]);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [problems, setProblems] = useState([]); // publish-validation details
  const E = useMemo(() => metaEndpoints(mode, protocolId), [mode, protocolId]);
  const isAdminMode = mode === 'admin';

  // `resetDraft`: replace the editable draft with the server copy. Only done on first load, after saving the
  // metadata and after a restore — NOT after adding a search term etc., which must not discard unsaved edits.
  const refresh = useCallback(async (resetDraft = true) => {
    const [p, cats, conds, vers] = await Promise.all([
      api.get(E.details),
      api.get(E.categories),
      api.get(E.conditions),
      E.versions ? api.get(E.versions) : Promise.resolve({ data: [] }),
    ]);
    setMeta(p.data);
    if (resetDraft) setDraft(toDraft(p.data));
    // the doctor catalog only ever lists ACTIVE entries and omits the flag; the admin lists carry it
    setCategories(isAdminMode ? cats.data : cats.data.map((c) => ({ ...c, isActive: true })));
    setConditions(isAdminMode ? conds.data : conds.data.map((c) => ({ ...c, isActive: true })));
    setVersions(vers.data);
    return p.data;
  }, [E, isAdminMode]);

  useEffect(() => {
    if (!enabled || !protocolId) return undefined;
    let cancelled = false;
    setLoading(true);
    refresh()
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, protocolId, refresh]);

  const dirty = Boolean(meta && draft && FIELDS.some((f) => (draft[f] || '') !== (toDraft(meta)[f] || '')));

  // Runs one action, refreshes the server copy afterwards, and turns failures into a message (+ problem list).
  const run = useCallback(async (fn, { resetDraft = false } = {}) => {
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const result = await fn();
      await refresh(resetDraft);
      return result;
    } catch (e) {
      setError(e.message);
      if (Array.isArray(e.details)) setProblems(e.details);
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const setField = useCallback((field, value) => setDraft((d) => ({ ...d, [field]: value })), []);

  // Admin-only actions: never sent to the server from a doctor session (it would refuse them anyway).
  const adminOnly = (fn) => (isAdminMode ? fn : async () => { setError('Only an administrator can do that.'); return null; });

  return {
    mode,
    canAdminister: isAdminMode,
    meta, draft, categories, conditions, versions, loading, busy, error, problems, dirty, setField,
    clearMessages: () => { setError(null); setProblems([]); },
    reload: () => run(async () => null),
    /** Saves the edited metadata fields. Resolves true when there was nothing to save or it succeeded. */
    saveMetadata: async () => {
      if (!dirty) return true;
      const body = {
        displayName: draft.displayName.trim() || null,
        shortDescription: draft.shortDescription,
        description: draft.description,
        categoryId: draft.categoryId || null,
      };
      return (await run(() => api.put(E.saveDetails, body), { resetDraft: true })) !== null;
    },
    addTerm: (term, kind) => run(() => api.post(E.searchTerms, { term, kind })),
    removeTerm: (termId) => run(() => api.delete(E.searchTerm(termId))),
    attachCondition: (conditionId) => run(() => { const a = E.attach(conditionId); return api.post(a.url, a.body); }),
    detachCondition: (conditionId) => run(() => api.delete(E.detach(conditionId))),
    createCondition: adminOnly((name) => run(async () => {
      const created = await api.post('/admin/conditions', { name });
      await api.post(`/admin/conditions/${created.data.id}/protocols`, { protocolId });
    })),
    createCategory: adminOnly(async (name) => {
      const id = await run(async () => (await api.post('/admin/categories', { name })).data.id);
      if (id) setDraft((d) => ({ ...d, categoryId: id })); // select it; still an unsaved edit until Save
      return Boolean(id);
    }),
    changeStatus: adminOnly((status) => run(() => api.post(`/admin/protocols/${protocolId}/status`, { status }))),
    archive: adminOnly(() => run(() => api.post(`/admin/protocols/${protocolId}/archive`))),
    publish: (note) => run(() => api.post(E.publish, { note: note || null })),
    restoreVersion: adminOnly(async (version) => {
      const result = await run(() => api.post(`/admin/protocols/${protocolId}/versions/${version}/restore`), { resetDraft: true });
      if (result !== null && onWorkingCopyChanged) await onWorkingCopyChanged();
      return result !== null;
    }),
  };
}
