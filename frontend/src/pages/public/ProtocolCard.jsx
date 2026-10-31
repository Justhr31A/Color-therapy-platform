import { Link } from 'react-router-dom';

/** One protocol summary card, as returned by GET /api/public/protocols. Nothing here is fetched separately —
 * every field comes straight from that one list response. */
export default function ProtocolCard({ protocol }) {
  const conditionNames = (protocol.conditions || []).map((c) => c.name).join(', ');
  return (
    <article className="pv-card">
      <div className="pv-card-body">
        {protocol.category && <span className="pv-card-tag">{protocol.category.name}</span>}
        <h3>{protocol.displayName || protocol.name}</h3>
        {conditionNames && <p className="pv-card-condition">{conditionNames}</p>}
        {protocol.shortDescription && <p className="pv-card-desc">{protocol.shortDescription}</p>}
      </div>
      <Link to={`/protocols/${protocol.slug}`} className="pv-btn pv-btn-primary pv-card-cta">View Protocol</Link>
    </article>
  );
}
