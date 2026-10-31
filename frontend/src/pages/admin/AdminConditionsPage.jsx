import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';

export const emptyForm = { name: '', description: '', synonymsText: '', isActive: true };
export const toFormFromCondition = (c) => ({ name: c.name, description: c.description || '', synonymsText: (c.synonyms || []).join(', '), isActive: c.isActive });
export const parseSynonyms = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** Client-side search: matches name, description or any synonym. There are typically only a handful of
 * conditions, so this needs no backend search parameter — the same reasoning as the public browser's filters. */
export function filterConditions(conditions, query) {
  const q = query.trim().toLowerCase();
  if (!q) return conditions;
  return conditions.filter((c) => c.name.toLowerCase().includes(q)
    || (c.description || '').toLowerCase().includes(q)
    || (c.synonyms || []).some((s) => s.toLowerCase().includes(q)));
}

/**
 * The actual page markup, as a pure function of already-resolved state (same split as the public pages: a
 * `useEffect` never runs during a static/server render, so only this half can be rendered and inspected in a
 * test without a live fetch having happened first).
 */
export function AdminConditionsView({
  conditions, loading, error, query, onQueryChange,
  formOpen, formMode, form, formError, saving, onOpenCreate, onOpenEdit, onCancelForm, onFormChange, onSubmit,
  onToggleActive,
}) {
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Conditions / Diseases</h1>
          <p className="muted small">Manage the conditions protocols can be linked to. Archiving a condition never removes its existing protocol links.</p>
        </div>
        <Link to="/dashboard" className="btn">← Dashboard</Link>
      </header>

      <div className="dashboard-toolbar condition-toolbar">
        <input
          type="search"
          className="condition-search"
          placeholder="Search conditions…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label="Search conditions"
        />
        <button type="button" className="btn primary" onClick={onOpenCreate}>+ Add Condition</button>
      </div>

      {formOpen && (
        <form className="card create-form" onSubmit={onSubmit}>
          <h2 className="condition-form-title">{formMode === 'edit' ? 'Edit Condition' : 'Add Condition'}</h2>
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => onFormChange({ ...form, name: e.target.value })} required maxLength={120} />
            <span className="muted small">Shown publicly, and used to generate this condition's URL slug.</span>
          </label>
          <label className="field">
            <span>Description</span>
            <textarea value={form.description} onChange={(e) => onFormChange({ ...form, description: e.target.value })} maxLength={5000} />
          </label>
          <label className="field">
            <span>Search terms / synonyms</span>
            <input
              value={form.synonymsText}
              onChange={(e) => onFormChange({ ...form, synonymsText: e.target.value })}
              placeholder="e.g. lower back pain, lumbago"
              aria-label="Search terms / synonyms"
            />
            <span className="muted small">Comma-separated. Helps this condition turn up under other names people might search for.</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.isActive} onChange={(e) => onFormChange({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          {formError && <p className="save-error">{formError}</p>}
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : formMode === 'edit' ? 'Save Changes' : 'Create Condition'}</button>
            <button type="button" className="btn" onClick={onCancelForm} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      {loading && <p>Loading conditions…</p>}
      {error && <p className="save-error" role="alert">{error}</p>}

      {!loading && !error && conditions.length === 0 && (
        <p className="muted">{query ? 'No conditions match your search.' : 'No conditions yet — add the first one above.'}</p>
      )}

      {!loading && conditions.length > 0 && (
        <table className="protocol-table admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Status</th>
              <th>Protocols</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {conditions.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="condition-desc-cell">{c.description || <span className="muted">—</span>}</td>
                <td><span className={`pill ${c.isActive ? 'status' : 'warn'}`}>{c.isActive ? 'Active' : 'Archived'}</span></td>
                <td>{c.protocolCount ?? 0}</td>
                <td className="row-actions">
                  <button type="button" className="btn small" onClick={() => onOpenEdit(c)}>Edit</button>
                  <button type="button" className="btn small danger" onClick={() => onToggleActive(c)}>
                    {c.isActive ? 'Archive' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * /admin/conditions — admin-only condition management. Reads and writes exclusively through the existing
 * GET/POST/PUT/:id/activate/:id/deactivate endpoints under /api/admin/conditions (see
 * backend/src/routes/admin.conditions.routes.js); nothing here is a second condition system, and archiving
 * never deletes a condition or its protocol links (the server only ever flips `is_active`).
 */
export default function AdminConditionsPage() {
  const [conditions, setConditions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState('create'); // 'create' | 'edit'
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const refresh = () => {
    setLoading(true);
    setError(null);
    api.get('/admin/conditions')
      .then((res) => setConditions(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const filtered = useMemo(() => filterConditions(conditions, query), [conditions, query]);

  const openCreate = () => { setFormMode('create'); setEditingId(null); setForm(emptyForm); setFormError(null); setFormOpen(true); };
  const openEdit = (c) => { setFormMode('edit'); setEditingId(c.id); setForm(toFormFromCondition(c)); setFormError(null); setFormOpen(true); };
  const cancelForm = () => { setFormOpen(false); setFormError(null); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setFormError('Name is required.'); return; }
    setSaving(true);
    setFormError(null);
    const payload = { name: form.name.trim(), description: form.description, synonyms: parseSynonyms(form.synonymsText), isActive: form.isActive };
    try {
      if (formMode === 'edit') await api.put(`/admin/conditions/${editingId}`, payload);
      else await api.post('/admin/conditions', payload);
      setFormOpen(false);
      refresh();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (c) => {
    try {
      await api.post(`/admin/conditions/${c.id}/${c.isActive ? 'deactivate' : 'activate'}`);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <AdminConditionsView
      conditions={filtered} loading={loading} error={error} query={query} onQueryChange={setQuery}
      formOpen={formOpen} formMode={formMode} form={form} formError={formError} saving={saving}
      onOpenCreate={openCreate} onOpenEdit={openEdit} onCancelForm={cancelForm} onFormChange={setForm} onSubmit={handleSubmit}
      onToggleActive={handleToggleActive}
    />
  );
}
