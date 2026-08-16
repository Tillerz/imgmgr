// Phrase extraction — turns prompts into a counted list of recurring phrases.
//
// Two prompt dialects live side by side in a typical library (measured here:
// ~67% tag-style, ~33% prose), so one splitter is not enough:
//
//   tag-style : "1girl, blonde hair, forest, (soft light:1.2)"
//   prose     : "...a woman with long red hair in a messy high ponytail, ..."
//
// Both are still comma-chunked — grammar commas cut prose into descriptive
// chunks just as tag commas cut a tag list. So step one is the same for both.
// The difference is what happens inside a chunk: a short chunk is already a
// concept and is kept whole, while a long one is cut into word runs (n-grams)
// because "long red hair in a messy high ponytail" is too specific to ever
// repeat, but "red hair" repeats thousands of times.
//
// No grammar knowledge is needed, and no NLP dependency: frequency is the
// judge. A real concept recurs across the library; an accidental word pair
// does not. Two cheap rules remove most of the noise — drop function words at
// a run's edges, and require a minimum count.
//
// Everything here is one linear pass over the words (see the O(n^2) invariant
// in CLAUDE.md).

import db from './db.js';

// Function words. A phrase may contain one ("hand on hip") but may not begin or
// end with one ("hair in a" is grammar debris, not a concept).
const STOPWORDS = new Set(`
a an the and or but if then else of in on at to from by for with without into onto over under
above below up down out off again further once here there all any both each few more most other
some such no nor not only own same so than too very can will just should now is are was were be
been being am do does did doing have has had having he she it they them his her hers him its
their theirs this that these those i you your yours my mine me we us our ours as also who whom
whose which what when where why how while during through between about against upon per via
`.trim().split(/\s+/));

const MAX_N = 3;          // longest word run counted inside a long chunk
const TAG_MAX_WORDS = 4;  // a chunk this short is treated as one ready-made tag
const MIN_COUNT = 3;      // a phrase seen once or twice is noise, not a concept

export const PHRASE_INDEX_VERSION = 1;

// Strip generator syntax so the same concept normalises to the same string:
// LoRA tags, attention weights, emphasis brackets, BREAK separators.
export function normalizePrompt(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')             // <lora:foo:0.8>, <hypernet:bar>
    .replace(/\bbreak\b/g, ',')           // SD's BREAK is a chunk separator
    .replace(/:\s*-?\d+(?:\.\d+)?/g, ' ') // the weight in (soft light:1.2)
    .replace(/[()[\]{}|]/g, ' ')          // emphasis brackets
    .replace(/[\r\n;.!?]+/g, ',')         // sentence enders also break chunks
    .replace(/[^a-z0-9',\- ]+/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

// Drop function words from both ends; interior ones are fine.
function trimStops(words) {
  let a = 0, b = words.length;
  while (a < b && STOPWORDS.has(words[a])) a++;
  while (b > a && STOPWORDS.has(words[b - 1])) b--;
  return a === 0 && b === words.length ? words : words.slice(a, b);
}

const cleanWord = w => w.replace(/^[-']+|[-']+$/g, '');
const usableWord = w => w.length > 1 && !/^\d+$/.test(w);

// Emit a run of content words as phrases: the run itself (when short enough)
// plus its suffixes. Suffixes and not every substring, because in English the
// head noun ends the phrase — "long red hair" yields "red hair" and "hair",
// which are real concepts, but never "long red", which is not.
function emitRun(run, out) {
  if (!run.length) return;
  if (run.length <= TAG_MAX_WORDS) out.add(run.join(' '));
  for (let n = 1; n <= Math.min(run.length, MAX_N); n++) {
    const suffix = run.slice(run.length - n);
    // A short chunk keeps its interior function words ("exposed in public"),
    // so a suffix can still start on one. "in public" is not a concept.
    if (STOPWORDS.has(suffix[0])) continue;
    out.add(suffix.join(' '));
  }
}

// The distinct phrases a single prompt contributes. A Set, so a word repeated
// inside one prompt still counts once — this is document frequency ("how many
// images use this?"), which is what the panel claims to show.
export function extractPhrases(text) {
  const out = new Set();
  if (!text) return out;

  for (const chunk of normalizePrompt(text).split(',')) {
    const words = chunk.split(' ').map(cleanWord).filter(usableWord);
    if (!words.length) continue;

    if (words.length <= TAG_MAX_WORDS) {
      // Tag-style chunk: already a concept, keep it whole (plus suffixes, so it
      // still matches the same concept written out in a prose prompt).
      emitRun(trimStops(words), out);
      continue;
    }

    // Prose chunk. Function words are treated as separators, not as material:
    // "a woman with long red hair in a messy high ponytail" breaks into the
    // runs [woman] [long red hair] [messy high ponytail]. Sliding a window
    // across the raw words instead would also produce "hair in messy" and
    // "standing in misty" — grammatically adjacent, conceptually garbage.
    let run = [];
    for (const w of words) {
      if (STOPWORDS.has(w)) { emitRun(run, out); run = []; }
      else run.push(w);
    }
    emitRun(run, out);
  }
  return out;
}

// Count every phrase across the library. One pass, one map.
export function computeCounts({ onProgress } = {}) {
  const counts = new Map();
  const rows = db.prepare(`
    SELECT positive_prompt AS p FROM images
    WHERE trashed_at IS NULL AND positive_prompt IS NOT NULL AND positive_prompt <> ''
  `);
  let seen = 0;
  for (const { p } of rows.iterate()) {
    for (const phrase of extractPhrases(p)) counts.set(phrase, (counts.get(phrase) || 0) + 1);
    if (++seen % 10000 === 0) onProgress?.(seen);
  }
  return { counts, prompts: seen };
}

// Rebuild the stored index. Phrases below MIN_COUNT are dropped on the way to
// disk, which is what keeps the table small next to a multi-million-entry map.
export function rebuildPhraseIndex({ onProgress, minCount = MIN_COUNT } = {}) {
  const started = Date.now();
  const { counts, prompts } = computeCounts({ onProgress });

  const rows = [];
  for (const [phrase, count] of counts) {
    if (count >= minCount) rows.push([phrase, count, phrase.split(' ').length]);
  }

  const insert = db.prepare('INSERT INTO phrase_counts (phrase, count, words) VALUES (?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM phrase_counts').run();
    for (const r of rows) insert.run(r);
  })();

  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run('phrase_index_version', String(PHRASE_INDEX_VERSION));
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run('phrase_index_built_at', String(Date.now()));

  return { prompts, distinct: counts.size, stored: rows.length, ms: Date.now() - started };
}

// A phrase that is merely a fragment of a longer one adds nothing: if "red
// hair" appears 3,400 times and "red" 3,450, the longer phrase is the real
// concept. Drop the short one when it is almost entirely explained by a longer
// phrase that contains it. Bounded to the fetched page, never the library.
const SUBSUME_RATIO = 0.9;
export function pruneFragments(list) {
  const longer = list.filter(r => r.words > 1);
  return list.filter(row => {
    if (row.words >= MAX_N) return true;
    const needle = ` ${row.phrase} `;
    for (const other of longer) {
      if (other === row || other.words <= row.words) continue;
      if (` ${other.phrase} `.includes(needle) && other.count >= row.count * SUBSUME_RATIO) return false;
    }
    return true;
  });
}

// Top phrases. `q` filters by substring, `min` raises the count floor, and
// `minWords` hides bare head nouns ("hair", "eyes") in favour of the two- and
// three-word phrases that actually describe something.
export function topPhrases({ limit = 200, q = '', min = 0, minWords = 1 } = {}) {
  const where = ['count >= ?', 'words >= ?'];
  const params = [Math.max(0, Number(min) || 0), Math.max(1, Number(minWords) || 1)];
  if (q) {
    where.push("phrase LIKE ? ESCAPE '\\'");
    params.push('%' + String(q).toLowerCase().replace(/[\\%_]/g, c => '\\' + c) + '%');
  }
  // Over-fetch so fragment pruning still leaves a full page.
  const raw = db.prepare(`
    SELECT phrase, count, words FROM phrase_counts
    WHERE ${where.join(' AND ')}
    ORDER BY count DESC, phrase ASC
    LIMIT ?
  `).all(...params, Math.min(2000, limit * 4));

  return pruneFragments(raw).slice(0, limit);
}

export function phraseIndexState() {
  const get = key => db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
  const stored = db.prepare('SELECT COUNT(*) AS n FROM phrase_counts').get().n;
  return {
    stored,
    builtAt: Number(get('phrase_index_built_at')) || 0,
    version: Number(get('phrase_index_version')) || 0,
    ready: stored > 0,
  };
}
