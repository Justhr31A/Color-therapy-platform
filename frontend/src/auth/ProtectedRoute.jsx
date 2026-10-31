import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * Client-side route gating is a UX convenience only — the real enforcement
 * happens on the server (see backend/src/middleware/roles.js), which
 * rejects any doctor-only API call from a non-doctor session regardless of
 * what URL was typed into the browser.
 */
export default function ProtectedRoute({ role, roles }) {
  // `role="doctor"` still works; `roles={['doctor', 'admin']}` allows several.
  const allowed = roles || (role ? [role] : null);
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="page-center">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (allowed && !allowed.includes(user.role)) {
    return (
      <div className="page-center">
        <div className="card">
          <h2>Access denied</h2>
          <p>Your account role ({user.role}) doesn&apos;t have access to this area.</p>
        </div>
      </div>
    );
  }
  return <Outlet />;
}
