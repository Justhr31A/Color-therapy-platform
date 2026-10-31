import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import PublicHeader from './PublicHeader';
import ProtocolCard from './ProtocolCard';
import MedicalDisclaimer from './MedicalDisclaimer';
import FindProtocolLink from './FindProtocolLink';

const STEPS = [
  { title: 'Choose a condition', body: 'Browse published protocols by category or search for what you need.' },
  { title: 'Explore the protocol', body: 'See exactly what a protocol involves before you commit to it.' },
  { title: 'View the mapped areas', body: 'Every protocol shows the specific hand areas it maps, on all four views.' },
  { title: 'Download the protocol', body: 'Take a copy with you — no account, no payment required for this.' },
];

/**
 * The actual page markup, as a pure function of already-resolved state — no fetching of its own. Split out
 * from `HomePage` (below) purely so it can be rendered and tested directly against any combination of
 * loading/empty/error/populated data, without needing a real fetch to have completed first (React does not
 * run `useEffect` during server/static rendering, so a component that fetches inside one cannot be tested by
 * rendering it directly and inspecting the output — only this prop-driven half can).
 */
export function HomePageView({ categories, featured, error }) {
  return (
    <div className="pv-page">
      <PublicHeader />

      <section className="pv-hero">
        <div className="pv-hero-inner">
          <h1>Explore Colour Therapy Protocols</h1>
          <p className="pv-hero-sub">
            Browse structured colour therapy protocols — each one shows exactly which areas of the hand it maps,
            drawn on real hand diagrams, so you know precisely what it involves before you use it.
          </p>
          <div className="pv-hero-ctas">
            <Link to="/protocols" className="pv-btn pv-btn-primary">Explore Protocols</Link>
            <FindProtocolLink variant="cta" />
            <a href="#how-it-works" className="pv-btn pv-btn-secondary">How It Works</a>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="pv-section">
        <h2>How It Works</h2>
        <div className="pv-steps">
          {STEPS.map((step, i) => (
            <div className="pv-step" key={step.title}>
              <div className="pv-step-num">{i + 1}</div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="pv-section">
        <h2>Protocol Categories</h2>
        {categories === null ? (
          <p className="pv-muted" role="status">Loading categories…</p>
        ) : categories.length === 0 ? (
          <p className="pv-muted">No categories are published yet. Check back soon.</p>
        ) : (
          <div className="pv-category-pills">
            {categories.map((c) => (
              <Link key={c.slug} to={`/protocols?category=${encodeURIComponent(c.slug)}`} className="pv-pill">{c.name}</Link>
            ))}
          </div>
        )}
      </section>

      <section className="pv-section">
        <h2>Featured Protocols</h2>
        {featured === null ? (
          <p className="pv-muted" role="status">Loading protocols…</p>
        ) : error ? (
          <p className="pv-error" role="alert">Protocols couldn't be loaded right now. Please try again shortly.</p>
        ) : featured.length === 0 ? (
          <div className="pv-empty">
            <p>No protocols have been published yet.</p>
            <p className="pv-muted">Check back soon, or explore the full browser once protocols are available.</p>
          </div>
        ) : (
          <>
            <div className="pv-card-grid">
              {featured.map((p) => <ProtocolCard key={p.slug} protocol={p} />)}
            </div>
            <div className="pv-section-cta"><Link to="/protocols" className="pv-link">See all protocols →</Link></div>
          </>
        )}
      </section>

      <MedicalDisclaimer />
    </div>
  );
}

/**
 * The public home page. Everything on it — categories, featured protocols — comes from the existing public
 * API (GET /api/public/categories, GET /api/public/protocols); nothing here is invented or hard-coded, so an
 * empty database shows an honest empty state instead of placeholder content pretending to be real.
 */
export default function HomePage() {
  const [categories, setCategories] = useState(null);
  const [featured, setFeatured] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/public/categories').then((res) => { if (!cancelled) setCategories(res.data); }).catch(() => { if (!cancelled) setCategories([]); });
    api
      .get('/public/protocols', { params: { limit: 6 } })
      .then((res) => { if (!cancelled) setFeatured(res.data.items); })
      .catch((err) => { if (!cancelled) { setFeatured([]); setError(err.message); } });
    return () => { cancelled = true; };
  }, []);

  return <HomePageView categories={categories} featured={featured} error={error} />;
}
