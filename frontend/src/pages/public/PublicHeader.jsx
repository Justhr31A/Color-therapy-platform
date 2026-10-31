import { Link } from 'react-router-dom';
import FindProtocolLink from './FindProtocolLink';

/** Header for every public page. Deliberately not the admin topbar — no builder/account chrome, just navigation. */
export default function PublicHeader() {
  return (
    <header className="pv-header">
      <Link to="/" className="pv-brand">Colour Therapy Protocols</Link>
      <nav className="pv-nav">
        <Link to="/protocols">Browse Protocols</Link>
        <FindProtocolLink />
        <Link to="/login" className="pv-nav-muted">Practitioner Login</Link>
      </nav>
    </header>
  );
}
