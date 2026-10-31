import { useState } from 'react';
import { publicProtocolPath, publicProtocolUrl, copyText } from '../viewer/shareLink';
import { downloadPublishedPdf } from '../viewer/pdf/publishedPdf';

const STATUS_LABELS = { draft: 'Draft', in_review: 'In review', published: 'Published', archived: 'Archived', active: 'Active (legacy)' };
const TERM_KINDS = [
  { value: 'keyword', label: 'Keyword' },
  { value: 'synonym', label: 'Synonym' },
  { value: 'phrase', label: 'Phrase' },
];

function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

/**
 * The "Protocol" tab: everything about the protocol that is not a marking — names, descriptions, category,
 * condition association, search terms, lifecycle status, publishing, sharing and version history. All of it talks
 * to the server through `meta` (see useProtocolMeta); nothing is kept in the browser.
 *
 * Two audiences, one panel:
 *  - a DOCTOR (isAdmin = false) manages their OWN protocol: describe it, choose an existing category and conditions,
 *    add search terms, save the draft, publish it (and publish again after later edits), then copy the public link,
 *    open the public page or download the PDF of the published version. Creating categories/conditions, status
 *    changes, archiving and version history/restore are administrator actions and are not offered.
 *  - an ADMIN (isAdmin = true) sees everything it always did.
 * The server enforces all of it; hiding a button here is only the UI keeping up with what the server allows.
 */
export default function ProtocolMetadataPanel({ isAdmin, canManage = isAdmin, meta, onPublish, onRestore, onSave, hasChanges = false, saving = false, origin }) {
  const [termText, setTermText] = useState('');
  const [termKind, setTermKind] = useState('keyword');
  const [newCondition, setNewCondition] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [pdf, setPdf] = useState({ busy: false, error: null });

  if (!canManage) {
    return (
      <div className="properties-panel">
        <p className="muted">Protocol details are available to doctors and administrators.</p>
      </div>
    );
  }
  if (meta.loading && !meta.meta) return <div className="properties-panel"><p className="muted">Loading protocol details…</p></div>;
  if (!meta.meta || !meta.draft) {
    return (
      <div className="properties-panel">
        {meta.error ? <p className="save-error">{meta.error}</p> : <p className="muted">Protocol details are not available.</p>}
      </div>
    );
  }

  const p = meta.meta;
  const draft = meta.draft;
  const attached = new Set(p.conditions.map((c) => c.id));
  const activeCategories = meta.categories.filter((c) => c.isActive || c.id === draft.categoryId);
  // the protocol's current category must stay selectable even if the list no longer offers it (for example it was deactivated)
  if (p.category && p.category.id === draft.categoryId && !activeCategories.some((c) => c.id === p.category.id)) activeCategories.push(p.category);
  const availableConditions = meta.conditions.filter((c) => c.isActive && !attached.has(c.id));
  const canPublish = p.status === 'draft' || p.status === 'in_review' || p.status === 'published';
  const doctorMode = !isAdmin;
  const publishLabel = doctorMode
    ? (p.status === 'published' ? 'Publish New Version' : 'Publish Protocol')
    : (p.status === 'published' ? 'Publish changes' : 'Publish');

  // The PDF is always built from the PUBLISHED version (the public render), never from the draft or unsaved edits.
  const downloadPdf = async () => {
    setPdf({ busy: true, error: null });
    try {
      await downloadPublishedPdf(p, { origin });
      setPdf({ busy: false, error: null });
    } catch (e) {
      setPdf({ busy: false, error: e && e.status === 404 ? 'The published version could not be found. Publish the protocol first.' : 'The PDF could not be built right now. Please try again.' });
    }
  };

  const submitTerm = async (e) => {
    e.preventDefault();
    if (!termText.trim()) return;
    if (await meta.addTerm(termText.trim(), termKind)) setTermText('');
  };

  return (
    <div className="properties-panel meta-panel">
      <div className="prop-header">
        <strong>Protocol details</strong>
        <span className={`pill ${p.status === 'published' ? 'status' : ''}`}>{STATUS_LABELS[p.status] || p.status}</span>
      </div>
      {p.status === 'published' && (
        <p className="published-state" role="status">
          <strong>✓ Published</strong>{p.published ? ` — version v${p.published.version} is live` : ''}
        </p>
      )}
      {doctorMode && (
        <p className="muted small">
          You can publish your own protocols. Publishing saves your latest edits first and freezes them as a new version; the public
          link keeps showing the last published version until you publish again.
        </p>
      )}
      {p.published && (
        <p className="muted small">
          Published version v{p.published.version}.{' '}
          {p.hasUnpublishedChanges ? <strong className="warn-text">There are unpublished changes.</strong> : 'No unpublished changes.'}
        </p>
      )}
      {meta.error && <p className="save-error" role="alert">{meta.error}</p>}
      {meta.problems.length > 0 && (
        <ul className="problem-list" aria-label="Problems that stopped publishing">
          {meta.problems.map((pr, i) => <li key={`${pr.path}-${i}`}>{pr.message || pr.code}</li>)}
        </ul>
      )}

      <fieldset className="prop-group">
        <legend>Description</legend>
        <label className="field"><span>Display name</span>
          <input type="text" maxLength={120} value={draft.displayName} placeholder={p.name} onChange={(e) => meta.setField('displayName', e.target.value)} />
        </label>
        <label className="field"><span>Short description</span>
          <input type="text" maxLength={280} value={draft.shortDescription} onChange={(e) => meta.setField('shortDescription', e.target.value)} />
        </label>
        <label className="field"><span>Description</span>
          <textarea rows={4} value={draft.description} onChange={(e) => meta.setField('description', e.target.value)} />
        </label>
        <label className="field"><span>Category</span>
          <select value={draft.categoryId} onChange={(e) => meta.setField('categoryId', e.target.value)}>
            <option value="">— none —</option>
            {activeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (inactive)'}</option>)}
          </select>
        </label>
        {isAdmin ? (
          <div className="inline-add">
            <input type="text" placeholder="New category…" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} aria-label="New category name" />
            <button type="button" className="btn small" disabled={meta.busy || !newCategory.trim()} onClick={async () => { if (await meta.createCategory(newCategory.trim())) setNewCategory(''); }}>Add</button>
          </div>
        ) : (
          <p className="muted small">Categories are managed by an administrator. Choose one from the list.</p>
        )}
        <p className="muted small">{meta.dirty ? 'Unsaved changes — use Save in the top bar.' : 'Saved.'}</p>
      </fieldset>

      <fieldset className="prop-group">
        <legend>Conditions</legend>
        {p.conditions.length === 0 && <p className="muted small">No condition linked yet.</p>}
        <ul className="chip-list">
          {p.conditions.map((c) => (
            <li key={c.id} className="chip">{c.name}
              <button type="button" aria-label={`Remove ${c.name}`} disabled={meta.busy} onClick={() => meta.detachCondition(c.id)}>×</button>
            </li>
          ))}
        </ul>
        {availableConditions.length > 0 && (
          <label className="field"><span>Link a condition</span>
            <select value="" disabled={meta.busy} onChange={(e) => e.target.value && meta.attachCondition(e.target.value)}>
              <option value="">Choose…</option>
              {availableConditions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        {isAdmin ? (
          <div className="inline-add">
            <input type="text" placeholder="New condition…" value={newCondition} onChange={(e) => setNewCondition(e.target.value)} aria-label="New condition name" />
            <button type="button" className="btn small" disabled={meta.busy || !newCondition.trim()} onClick={async () => { if (await meta.createCondition(newCondition.trim())) setNewCondition(''); }}>Add &amp; link</button>
          </div>
        ) : (
          <p className="muted small">Conditions are managed by an administrator. Link the ones that apply from the list.</p>
        )}
      </fieldset>

      <fieldset className="prop-group">
        <legend>Search terms</legend>
        <ul className="chip-list">
          {p.searchTerms.map((t) => (
            <li key={t.id} className="chip" title={t.kind}>{t.term}
              <button type="button" aria-label={`Remove ${t.term}`} disabled={meta.busy} onClick={() => meta.removeTerm(t.id)}>×</button>
            </li>
          ))}
        </ul>
        <form className="inline-add" onSubmit={submitTerm}>
          <input type="text" placeholder="Synonym, keyword or phrase…" value={termText} onChange={(e) => setTermText(e.target.value)} aria-label="Search term" />
          <select value={termKind} onChange={(e) => setTermKind(e.target.value)} aria-label="Search term kind">
            {TERM_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <button type="submit" className="btn small" disabled={meta.busy || !termText.trim()}>Add</button>
        </form>
      </fieldset>

      <fieldset className="prop-group">
        <legend>Status &amp; publishing</legend>
        {isAdmin && (
          <div className="prop-actions">
            {p.status === 'draft' && <button type="button" className="btn small" disabled={meta.busy} onClick={() => meta.changeStatus('in_review')}>Send to review</button>}
            {p.status === 'in_review' && <button type="button" className="btn small" disabled={meta.busy} onClick={() => meta.changeStatus('draft')}>Back to draft</button>}
            {p.status === 'archived' && <button type="button" className="btn small" disabled={meta.busy} onClick={() => meta.changeStatus('draft')}>Return to draft</button>}
            {p.status !== 'archived' && <button type="button" className="btn small danger" disabled={meta.busy} onClick={() => { if (window.confirm('Archive this protocol? It stops being public.')) meta.archive(); }}>Archive</button>}
          </div>
        )}
        {doctorMode && (
          <div className="prop-actions">
            <button type="button" className="btn small" disabled={meta.busy || saving || !hasChanges} onClick={onSave}>{saving ? 'Saving…' : 'Save Draft'}</button>
          </div>
        )}
        {doctorMode && p.status === 'archived' && <p className="muted small">This protocol is archived, so it is not public. An administrator can return it to draft.</p>}
        {canPublish && (
          <>
            <label className="field"><span>Publish note (optional)</span>
              <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <button type="button" className="btn primary" disabled={meta.busy} onClick={async () => { if (await onPublish(note)) setNote(''); }}>
              {publishLabel}
            </button>
            <p className="muted small">Publishing saves your latest edits first, then freezes them as a new immutable version. Later edits stay in the draft until you publish again.</p>
          </>
        )}
      </fieldset>

      {p.status === 'published' && p.slug && (
        <fieldset className="prop-group share-group">
          <legend>Share</legend>
          <p className="muted small">
            Anyone with this link can view the published protocol{p.published ? ` (version v${p.published.version})` : ''} and download its PDF.
            Drafts and unpublished edits are never visible through it.
          </p>
          <input type="text" readOnly className="share-url" aria-label="Public protocol link" value={publicProtocolUrl(p.slug, origin)} onFocus={(e) => e.target.select()} />
          <div className="prop-actions">
            <button
              type="button"
              className="btn small primary"
              onClick={async () => { const ok = await copyText(publicProtocolUrl(p.slug, origin)); setCopied(ok); setCopyFailed(!ok); if (ok) setTimeout(() => setCopied(false), 2500); }}
            >
              {copied ? 'Link copied' : 'Copy Share Link'}
            </button>
            <a className="btn small" href={publicProtocolPath(p.slug)} target="_blank" rel="noopener noreferrer">Open Public Protocol</a>
            {p.published && (
              <button type="button" className="btn small" disabled={pdf.busy} onClick={downloadPdf}>{pdf.busy ? 'Preparing PDF…' : 'Download PDF'}</button>
            )}
          </div>
          {copyFailed && <p className="save-error small" role="alert">The link could not be copied automatically. Select it in the box above and copy it by hand.</p>}
          {pdf.error && <p className="save-error small" role="alert">{pdf.error}</p>}
          {p.published && <p className="muted small">The PDF is made from the published version (v{p.published.version}), never from your unsaved edits.</p>}
          {p.hasUnpublishedChanges && <p className="muted small warn-text">You have unpublished changes. The link still shows the published version until you publish again.</p>}
        </fieldset>
      )}

      {isAdmin && (
        <fieldset className="prop-group">
          <legend>Version history</legend>
          {meta.versions.length === 0 && <p className="muted small">No versions yet.</p>}
          <ul className="version-list">
            {meta.versions.map((v) => (
              <li key={v.version}>
                <span><strong>v{v.version}</strong> · {v.kind}{v.isCurrentlyPublished ? ' · live' : ''}{v.restoredFromVersion ? ` · from v${v.restoredFromVersion}` : ''}<br /><span className="muted small">{formatWhen(v.createdAt)}</span></span>
                <button type="button" className="btn small" disabled={meta.busy} onClick={() => onRestore(v.version)}>Restore</button>
              </li>
            ))}
          </ul>
          <p className="muted small">Restoring copies an old version into the draft; the old version itself never changes.</p>
        </fieldset>
      )}
    </div>
  );
}
