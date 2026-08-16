import express from 'express';
import db from '../db.js';
import { topPhrases, phraseIndexState, rebuildPhraseIndex } from '../phrases.js';
import { buildSearchClause } from './images.js';

const router = express.Router();

const promotedTags = () =>
  db.prepare("SELECT DISTINCT tag FROM tags WHERE source = 'phrase' ORDER BY tag").all().map(r => r.tag);

// Read-only: the counted phrase list that backs the suggestion panel.
// Nothing here writes to images, tags or metadata — clicking a phrase in the UI
// just fills the search box with prompt:"...".
router.get('/', (req, res) => {
  const state = phraseIndexState();
  if (!state.ready) return res.json({ ...state, phrases: [], promoted: [] });

  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const minWords = Math.max(1, Number(req.query.minWords) || 1);
  const phrases = topPhrases({
    limit,
    q: String(req.query.q || '').trim(),
    min: Number(req.query.min) || 0,
    minWords,
  });
  res.json({ ...state, phrases, promoted: promotedTags() });
});

// Promote a phrase to a real tag: tag every image whose prompt uses it.
//
// The match uses the same loose `phrase:` rule the panel's click uses, so the
// number of images tagged agrees with the count the panel showed. Only phrases
// that are actually in the index can be promoted — this endpoint is not a
// general "tag everything matching arbitrary text" hole.
router.post('/tag', (req, res) => {
  const phrase = String(req.body?.phrase || '').trim().toLowerCase();
  if (!phrase || phrase.includes('"')) return res.status(400).json({ error: 'phrase required' });

  const known = db.prepare('SELECT 1 FROM phrase_counts WHERE phrase = ?').get(phrase);
  if (!known) return res.status(404).json({ error: 'unknown phrase — rebuild the index?' });

  const { clause, params } = buildSearchClause(`phrase:"${phrase}"`, 'i.');
  const info = db.prepare(`
    INSERT OR IGNORE INTO tags (image_id, tag, source)
    SELECT i.id, ?, 'phrase' FROM images i
    WHERE i.trashed_at IS NULL AND ${clause}
  `).run(phrase, ...params);

  res.json({ ok: true, tag: phrase, tagged: info.changes });
});

// Undo a promotion. Scoped to source='phrase', so a hand-made tag that happens
// to share the name is left alone.
router.delete('/tag', (req, res) => {
  const tag = String(req.body?.tag || '').trim().toLowerCase();
  if (!tag) return res.status(400).json({ error: 'tag required' });
  const info = db.prepare("DELETE FROM tags WHERE tag = ? AND source = 'phrase'").run(tag);
  res.json({ ok: true, tag, removed: info.changes });
});

// Rebuild on demand. Synchronous and a few seconds on ~100k prompts; guarded so
// two clients cannot start overlapping rebuilds.
let rebuilding = false;
router.post('/rebuild', (req, res) => {
  if (rebuilding) return res.json({ status: 'already running' });
  rebuilding = true;
  try {
    const result = rebuildPhraseIndex();
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    rebuilding = false;
  }
});

export default router;
