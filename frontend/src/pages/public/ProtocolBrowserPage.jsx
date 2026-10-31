import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import PublicHeader from './PublicHeader';
import ProtocolCard from './ProtocolCard';

export function dedupeConditions(items) {
  const seen = new Map();
  (items || []).forEach((p) => (p.conditions || []).forEach((c) => { if (!seen.has(c.slug)) seen.set(c.slug, c); }));
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The actual page markup, as a pure function of already-resolved state (see HomePageView's comment for why
 * this is split out from the fetching wrapper below: `useEffect` never runs during a static/server render, so
 * only this half can be rendered directly and inspected in a test).
 */
export function ProtocolBrowserView({ categories, items, error, availableConditions, q, category, condition, hasFilters, onSetParam, onClearFilters }) {
  return (
    <div className="pv-page">
      <PublicHeader />
      <div className="pv-section pv-browser">
        <h1>Browse Protocols</h1>

        <div className="pv-filters">
          <input
            type="search"
            className="pv-search"
            placeholder="Search protocols…"
            value={q}
            onChange={(e) => onSetParam('q', e.target.value)}
            aria-label="Search protocols"
          />
          <select value={category} onChange={(e) => onSetParam('category', e.target.value)} aria-label="Filter by category">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          {availableConditions.length > 0 && (
            <select value={condition} onChange={(e) => onSetParam('condition', e.target.value)} aria-label="Filter by condition">
              <option value="">All conditions</option>
              {availableConditions.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          )}
          {hasFilters && (
            <button type="button" className="pv-btn pv-btn-ghost" onClick={onClearFilters}>Clear filters</button>
          )}
        </div>

        {items === null ? (
          <p className="pv-muted" role="status">Loading protocols…</p>
        ) : error ? (
          <p className="pv-error" role="alert">Protocols couldn't be loaded right now. Please try again shortly.</p>
        ) : items.length === 0 ? (
          <div className="pv-empty">
            <p>No protocols match your search.</p>
            {hasFilters && <button type="button" className="pv-link" onClick={onClearFilters}>Clear filters and see everything</button>}
          </div>
        ) : (
          <div className="pv-card-grid">
            {items.map((p) => <ProtocolCard key={p.slug} protocol={p} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * /protocols — the public browser. Everything shown comes straight from GET /api/public/protocols (published
 * protocols only, enforced server-side) and GET /api/public/categories; this page never talks to the admin or
 * builder APIs and never sees a draft.
 */
export default function ProtocolBrowserPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  const condition = params.get('condition') || '';

  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [availableConditions, setAvailableConditions] = useState([]);

  useEffect(() => {
    api.get('/public/categories').then((res) => setCategories(res.data)).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    api
      .get('/public/protocols', { params: { q: q || undefined, category: category || undefined, condition: condition || undefined, limit: 60 } })
      .then((res) => {
        if (cancelled) return;
        setItems(res.data.items);
        // Only widen the condition list from an UNFILTERED-by-condition result, so picking one condition
        // doesn't narrow away the others still available for the current search/category.
        if (!condition) setAvailableConditions(dedupeConditions(res.data.items));
      })
      .catch((err) => { if (!cancelled) { setItems([]); setError(err.message); } });
    return () => { cancelled = true; };
  }, [q, category, condition]);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const clearFilters = () => setParams({}, { replace: true });

  return (
    <ProtocolBrowserView
      categories={categories} items={items} error={error} availableConditions={availableConditions}
      q={q} category={category} condition={condition} hasFilters={Boolean(q || category || condition)}
      onSetParam={setParam} onClearFilters={clearFilters}
    />
  );
}
