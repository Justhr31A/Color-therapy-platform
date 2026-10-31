import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../auth/AuthContext';

export default function PatientDashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [protocols, setProtocols] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get('/patient/protocols')
      .then((res) => setProtocols(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <h1>My Protocols</h1>
          <p className="muted">Signed in as {user.name} ({user.email})</p>
        </div>
        <button className="btn" onClick={logout}>
          Log out
        </button>
      </header>

      {loading && <p>Loading your protocols…</p>}
      {error && <p className="save-error">{error}</p>}
      {!loading && protocols.length === 0 && (
        <p className="muted">No protocols have been assigned to you yet — check back after your doctor assigns one.</p>
      )}

      {protocols.length > 0 && (
        <div className="patient-protocol-list">
          {protocols.map((p) => (
            <div key={p.id} className="card patient-protocol-card">
              <div>
                <h3>{p.name}</h3>
                <p className="muted small">
                  From Dr. {p.doctorName} · {p.protocolType === 'hand' ? 'Hand protocol' : 'Organ/body protocol'} ·
                  v{p.currentVersion}
                </p>
                {p.description && <p className="muted small">{p.description}</p>}
              </div>
              {p.canStart ? (
                <button className="btn primary" onClick={() => navigate(`/patient/protocols/${p.id}`)}>
                  Open
                </button>
              ) : (
                <span className="pill warn">Not yet activated by your doctor</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
