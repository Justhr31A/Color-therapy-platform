import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../auth/AuthContext';

/**
 * A patient row is created "pending" (no password) when a doctor assigns
 * them a protocol by email. This page is how that turns into a real login.
 *
 * KNOWN LIMITATION: this only checks that the email has a pending invite —
 * it does not verify the requester actually owns that email (no emailed
 * token). Fine for local development/testing the Phase 2 camera flow, not
 * fine for real patient data. See the comment on the backend route
 * (backend/src/routes/auth.routes.js, POST /api/auth/patient/activate) for
 * what a real version needs.
 */
export default function PatientActivatePage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/patient/activate', { email, password });
      await login(email, password);
      navigate('/patient/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-center">
      <form className="card auth-card" onSubmit={handleSubmit}>
        <h1>Colour Therapy Protocol Platform</h1>
        <p className="muted">Set up your patient account</p>
        <p className="muted small">
          Your doctor has assigned you a protocol. Enter the same email they used and choose a
          password to activate your account.
        </p>
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Choose a password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          <span className="muted small">At least 8 characters.</span>
        </label>
        {error && <p className="save-error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Setting up…' : 'Activate account'}
        </button>
        <p className="muted small">
          Already activated? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
