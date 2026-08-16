import React, { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

// Recurring phrases mined from the prompts (see server/phrases.js).
//
// Read-only on purpose: this writes nothing to the database. Clicking a phrase
// only fills the search box with prompt:"…", so the panel is a way to *browse*
// what is in the library rather than type a guess at it. If the list turns out
// to be useful, promoting phrases to real tags is the natural next step.
export default function PhrasePanel({ onPick, activeSearch = '' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [multiWord, setMultiWord] = useState(true);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['phrases', q, multiWord],
    queryFn: () => api.phrases({ limit: 150, q, minWords: multiWord ? 2 : 1 }),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const rebuild = useCallback(async () => {
    setBusy(true);
    try {
      await api.rebuildPhrases();
      await qc.invalidateQueries({ queryKey: ['phrases'] });
    } finally {
      setBusy(false);
    }
  }, [qc]);

  // Promoting writes one tag row per matching image, so it reports what it did
  // and clicking again removes the batch. Small promotions go straight through:
  // a prompt asking to confirm 6 rows is noise, and noise is what teaches people
  // to dismiss prompts without reading them. Above this many images it is a big
  // enough change to be worth a beat.
  const CONFIRM_ABOVE = 500;
  const [pending, setPending] = useState('');
  const [note, setNote] = useState('');
  const togglePromote = useCallback(async (phrase, isTag, count) => {
    if (!isTag && count >= CONFIRM_ABOVE) {
      const ok = window.confirm(
        `Tag ${count.toLocaleString()} images as "${phrase}"?\n\n` +
        `This adds a real tag to your library, not a filter. ` +
        `You can undo it in one click.`
      );
      if (!ok) return;
    }
    setPending(phrase);
    setNote('');
    try {
      const r = isTag ? await api.demotePhrase(phrase) : await api.promotePhrase(phrase);
      setNote(isTag
        ? `Removed tag "${phrase}" from ${r.removed.toLocaleString()} images.`
        : `Tagged ${r.tagged.toLocaleString()} images as "${phrase}".`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['phrases'] }),
        qc.invalidateQueries({ queryKey: ['allTags'] }),
        qc.invalidateQueries({ queryKey: ['images'] }),
      ]);
    } catch (e) {
      setNote(`Failed: ${e.message}`);
    } finally {
      setPending('');
    }
  }, [qc]);

  const phrases = data?.phrases || [];
  const promoted = new Set(data?.promoted || []);
  const built = data?.builtAt ? new Date(data.builtAt).toLocaleString() : null;

  return (
    <div className={`phrase-panel ${open ? 'open' : ''}`}>
      <button className="phrase-header" onClick={() => setOpen(o => !o)}>
        <span className="phrase-caret">{open ? '▾' : '▸'}</span>
        Prompt phrases
      </button>

      {open && (
        <div className="phrase-body">
          <input
            className="phrase-filter"
            type="text"
            value={q}
            placeholder="Filter phrases…"
            onChange={e => setQ(e.target.value)}
          />

          <label className="phrase-opt" title="Hide single words like &quot;hair&quot; or &quot;eyes&quot; and show only descriptive phrases.">
            <input
              type="checkbox"
              checked={multiWord}
              onChange={e => setMultiWord(e.target.checked)}
            />
            2+ words only
          </label>

          {isLoading && <div className="phrase-empty">Loading…</div>}

          {!isLoading && data && !data.ready && (
            <div className="phrase-empty">
              Not built yet.
              <button className="phrase-rebuild" onClick={rebuild} disabled={busy}>
                {busy ? 'Building…' : 'Build now'}
              </button>
            </div>
          )}

          {!isLoading && data?.ready && phrases.length === 0 && (
            <div className="phrase-empty">No phrase matches.</div>
          )}

          <ul className="phrase-list">
            {phrases.map(p => {
              // `phrase:` and not `prompt:` — it also matches the underscored
              // spelling of the same concept, which is how the panel counted it.
              const term = `phrase:"${p.phrase}"`;
              const isTag = promoted.has(p.phrase);
              return (
                <li key={p.phrase} className="phrase-row">
                  <button
                    className={`phrase-item ${activeSearch.includes(term) ? 'active' : ''}`}
                    onClick={() => onPick(term)}
                    title={`Search for phrase:"${p.phrase}"`}
                  >
                    <span className="phrase-text">{p.phrase}</span>
                    <span className="phrase-count">{p.count.toLocaleString()}</span>
                  </button>
                  <button
                    className={`phrase-tag-btn ${isTag ? 'on' : ''}`}
                    disabled={pending === p.phrase}
                    onClick={() => togglePromote(p.phrase, isTag, p.count)}
                    title={isTag
                      ? `Remove the tag "${p.phrase}" from all images`
                      : `Make "${p.phrase}" a real tag on about ${p.count.toLocaleString()} images`}
                  >
                    {pending === p.phrase ? '…' : isTag ? '✓' : '+'}
                  </button>
                </li>
              );
            })}
          </ul>

          {note && <div className="phrase-note">{note}</div>}

          {data?.ready && (
            <div className="phrase-foot">
              <span title={built ? `Built ${built}` : ''}>
                {data.stored.toLocaleString()} phrases
              </span>
              <button className="phrase-rebuild" onClick={rebuild} disabled={busy}>
                {busy ? 'Rebuilding…' : 'Rebuild'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
