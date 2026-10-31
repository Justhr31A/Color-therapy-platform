import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../../api/client';

/**
 * Read-only protocol view for the patient. The patient cannot edit anything
 * here — there is no canvas, no toolbar, no properties panel. This reuses
 * the exact same protocol data the doctor saved (same normalized object
 * model, same GET /api/patient/protocols/:id ownership-checked endpoint) —
 * never a second, patient-specific copy of the data.
 *
 * Automatic left/right and front/back detection (Phase 2 Steps 6-7) isn't
 * built yet, so for now the patient explicitly picks which saved view
 * they're about to demonstrate to the camera — a "controlled interaction"
 * in the spec's own words, which is also the documented fallback for when
 * automatic orientation detection isn't reliable.
 */
export default function PatientProtocolPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [protocol, setProtocol] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get(`/patient/protocols/${id}`)
      .then((res) => setProtocol(res.data))
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) {
    return (
      <div className="page-center">
        <div className="card">
          <h2>Couldn&apos;t open protocol</h2>
          <p>{error}</p>
          <Link to="/patient/dashboard">Back</Link>
        </div>
      </div>
    );
  }

  if (!protocol) {
    return <div className="page-center">Loading…</div>;
  }

  return (
    <div className="dashboard-page">
      <Link to="/patient/dashboard" className="back-link">
        ← My Protocols
      </Link>
      <h1>{protocol.name}</h1>
      <p className="muted">From Dr. {protocol.doctorName}</p>
      {protocol.description && <p>{protocol.description}</p>}

      <h3>Which view are you about to show?</h3>
      <p className="muted small">Choose the one that matches how you're about to hold your hand up to the camera.</p>

      <div className="patient-view-grid">
        {protocol.canvases.map((c) => (
          <button
            key={c.id}
            className="card patient-view-card"
            onClick={() =>
              navigate(`/patient/protocols/${protocol.id}/session/${c.id}`, {
                state: { viewLabel: c.backgroundLabel, canvas: c },
              })
            }
          >
            <strong>{c.backgroundLabel}</strong>
            <span className="muted small">{c.objects.length} marking{c.objects.length === 1 ? '' : 's'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
