import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../auth/AuthContext';

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [protocols, setProtocols] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const [organAssets, setOrganAssets] = useState([]);
  const [form, setForm] = useState({ name: '', description: '', protocolType: 'hand', organKeys: [] });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const refresh = () => {
    setLoading(true);
    api
      .get('/protocols')
      .then((res) => setProtocols(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    api
      .get('/assets/organs')
      .then((res) => setOrganAssets(res.data))
      .catch(() => setOrganAssets([]));
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description,
        protocolType: form.protocolType,
        organKeys: form.protocolType === 'organ' ? form.organKeys : undefined,
      };
      const res = await api.post('/protocols', payload);
      setShowCreate(false);
      setForm({ name: '', description: '', protocolType: 'hand', organKeys: [] });
      navigate(`/builder/${res.data.id}`);
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDuplicate = async (id) => {
    await api.post(`/protocols/${id}/duplicate`);
    refresh();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this protocol permanently? This cannot be undone.')) return;
    await api.delete(`/protocols/${id}`);
    refresh();
  };

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <h1>Colour Therapy Protocols</h1>
          <p className="muted">Signed in as {user.name} ({user.email})</p>
        </div>
        <div className="row-actions">
          {user.role === 'admin' && <Link to="/admin/conditions" className="btn">Conditions / Diseases</Link>}
          {user.role === 'admin' && <Link to="/admin/ai" className="btn">AI Assistant</Link>}
          {user.role === 'admin' && <Link to="/admin/camera" className="btn">Camera (AR)</Link>}
          {user.role === 'admin' && <Link to="/admin/hand-reference" className="btn">Hand reference</Link>}
          {user.role === 'admin' && <Link to="/admin/payments" className="btn">Payment Access</Link>}
          <button className="btn" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <div className="dashboard-toolbar">
        <button className="btn primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : '+ Create Protocol'}
        </button>
      </div>

      {showCreate && (
        <form className="card create-form" onSubmit={handleCreate}>
          <label className="field">
            <span>Protocol name</span>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </label>
          <div className="field">
            <span>Protocol type</span>
            <div className="radio-row">
              <label>
                <input
                  type="radio"
                  checked={form.protocolType === 'hand'}
                  onChange={() => setForm((f) => ({ ...f, protocolType: 'hand' }))}
                />
                Hand (4 views: Left/Right Front & Back)
              </label>
              <label>
                <input
                  type="radio"
                  checked={form.protocolType === 'organ'}
                  onChange={() => setForm((f) => ({ ...f, protocolType: 'organ' }))}
                />
                Organ / Body
              </label>
            </div>
          </div>

          {form.protocolType === 'organ' && (
            <div className="field">
              <span>Organ/body diagrams to include</span>
              {organAssets.map((a) => (
                <label key={a.key} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.organKeys.includes(a.key)}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        organKeys: e.target.checked
                          ? [...f.organKeys, a.key]
                          : f.organKeys.filter((k) => k !== a.key),
                      }))
                    }
                  />
                  {a.label}
                  {a.isPlaceholder && <span className="pill warn">placeholder</span>}
                </label>
              ))}
              {organAssets.length === 0 && <p className="muted small">No organ/body assets configured yet.</p>}
            </div>
          )}

          {createError && <p className="save-error">{createError}</p>}
          <button className="btn primary" type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create & Open Builder'}
          </button>
        </form>
      )}

      {loading && <p>Loading protocols…</p>}
      {error && <p className="save-error">{error}</p>}

      {!loading && protocols.length === 0 && <p className="muted">No protocols yet — create your first one above.</p>}

      {protocols.length > 0 && (
        <table className="protocol-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Version</th>
              <th>Patient</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {protocols.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`/builder/${p.id}`} onClick={(e) => { e.preventDefault(); navigate(`/builder/${p.id}`); }}>
                    {p.name}
                  </a>
                </td>
                <td>{p.protocolType}</td>
                <td>
                  <span className="pill status">{p.status}</span>
                </td>
                <td>v{p.currentVersion}</td>
                <td>{p.patient ? `${p.patient.name} (${p.patient.status})` : '—'}</td>
                <td>{new Date(p.updatedAt).toLocaleString()}</td>
                <td className="row-actions">
                  <button className="btn small" onClick={() => navigate(`/builder/${p.id}`)}>
                    Open
                  </button>
                  <button className="btn small" onClick={() => handleDuplicate(p.id)}>
                    Duplicate
                  </button>
                  <button className="btn small danger" onClick={() => handleDelete(p.id)}>
                    Delete
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
