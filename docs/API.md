# imgmgr HTTP API

imgmgr is driven entirely by a small JSON HTTP API served by the same Express
process that serves the web client. This document describes every endpoint.

- **Base URL:** `http://localhost:<port>` (default port `3000`, see `config.json`)
- **Auth:** none — the server is intended to run locally on a trusted machine
- **Request bodies:** JSON, with `Content-Type: application/json`
- **Responses:** JSON, unless the endpoint returns image bytes (thumbnails / full images)

All paths below are relative to the base URL.

## Conventions

- **`id`** is the integer primary key of an image (`images.id`).
- Timestamps (`mtime`, `trashed_at`, `indexed_at`) are **epoch milliseconds**.
- **`favorite`** is the star rating, an integer `0`–`5` (`0` = unrated).
- Deletes are **soft** — images move to a trash and can be restored (see [Trash](#trash-lifecycle)).
- **Starred images (favorite ≥ 1) are protected**: delete endpoints refuse them and
  return their ids in a `skipped` array instead of deleting.

---

## Images

### `GET /api/images`

List images with filtering, sorting, and pagination.

**Query parameters** (all optional):

| Param | Default | Description |
| --- | --- | --- |
| `folder` | — | Restrict to an exact `folder_path`. |
| `sort` | `mtime-desc` | One of `mtime-desc`, `mtime-asc`, `name-asc`, `name-desc`, `fav-desc`, `fav-asc`. |
| `favorite_min` | `0` | Only images with `favorite >= this`. |
| `favorite_eq` | — | Only images with **exactly** this rating (`0` = unrated). Overrides `favorite_min`. |
| `caption` | — | `1` = only images that have an AI caption, `0` = only those without. Blank captions count as none. |
| `search` | — | Text filter over filename + positive prompt (captions via a `caption:` prefix). See [Search syntax](#search-syntax). |
| `tag` | — | Only images carrying this tag. |
| `facets` | — | JSON object of generation-param filters, e.g. `{"Model":"x","Sampler":"Euler a"}`. Multiple keys are ANDed. See [Facets](#facets). |
| `trashed` | — | `1` to list **only** trashed images (ignores `folder`/`favorite_min`, sorted by trash time). Omit for normal results. |
| `meta_key` + `meta_value` | — | Legacy single metadata `LIKE` filter (prefer `facets`). |
| `limit` | `100` | Page size. |
| `offset` | `0` | Page offset. |
| `max_id` | — | Only images with `id <= max_id`. Pass back the `snapshot` from your first page to keep paging stable — see [Stable pagination](#stable-pagination). |
| `missing` | — | `1` = only images whose file is offline, `0` = only images whose file is present. Omit to include both. See [Offline images](#offline-images). |

**Response** `{ images: Image[], total: number, snapshot: number }` where `total`
is the full match count (not just this page) and `snapshot` is the `max_id` this
query was evaluated against. Each `Image`:

```json
{
  "id": 97310,
  "path": "~/sd/images/2026/2026-07-23/20260723230644-1171577535.webp",
  "filename": "20260723230644-1171577535.webp",
  "folder_path": "~/sd/images/2026/2026-07-23",
  "size": 177276,
  "mtime": 1784900000000,
  "width": 1024,
  "height": 1024,
  "format": "webp",
  "favorite": 0,
  "file_hash": "…",
  "positive_prompt": "…",
  "negative_prompt": "…",
  "trashed_at": null,
  "missing_at": null
}
```

```bash
curl 'http://localhost:3000/api/images?search=sunset%20-blurry&sort=fav-desc&limit=50'
curl 'http://localhost:3000/api/images?facets=%7B%22Model%22%3A%22perfectdeliberate_XL%22%7D'
```

### `GET /api/images/counts`

Favorite-level histogram for the current filters — powers the `Min ★` counts.

**Query:** the shared filter set minus the rating filters (it groups by rating):
`folder`, `search`, `tag`, `facets`, `missing`, `caption`.

**Response:** an object keyed by rating → count, e.g. `{ "0": 19254, "5": 1 }`.

### `GET /api/images/ids`

All image ids matching the filters — used by "select all" and by the slideshow,
both of which need to cover pages the client hasn't loaded.

**Query:** the same filter set as `GET /api/images` — `folder`, `favorite_min`,
`favorite_eq`, `search`, `tag`, `facets`, `missing`, `caption`. Returned in the
same order as the default listing (`mtime DESC, id DESC`).

**Response:** `number[]`.

> `GET /api/images`, `/counts` and `/ids` share one filter builder, so all three
> always agree on what the current view contains.

### `GET /api/images/:id`

Full record for one image (all columns, including `phash`, `thumbnail_path`,
`original_path`, `indexed_at`).

**Response:** a single image object, or `404 { "error": "not found" }`.

### `GET /api/images/:id/metadata`

All raw metadata key/value pairs for the image (EXIF tags, `UserComment`,
`parameters`, and the extracted generation params like `Model`, `Sampler`).

**Response:** `[{ "key": "Sampler", "value": "Euler a" }, …]`.

### `GET /api/images/:id/similar`

Find visually similar images using the perceptual hash (DCT-based pHash).

**Query:** `threshold` (Hamming distance, default `10`, clamped 0–32),
`limit` (default `200`, max `500`).

**Response:** `{ images: Image[], total }` where each image also has a
`distance` field (0 = identical hash), sorted nearest-first. Trashed images are excluded.

```bash
curl 'http://localhost:3000/api/images/97310/similar?threshold=8'
```

### `PATCH /api/images/:id`

Set the star rating of one image.

**Body:** `{ "favorite": 0..5 }` → `{ "ok": true }`.

### `PATCH /api/images/favorite/bulk`

Set the star rating on many images at once.

**Body:** `{ "ids": number[], "favorite": 0..5 }`
**Response:** `{ "ok": true, "updated": number, "favorite": number }`.

### `POST /api/images/move`

Move images to another folder on disk (and update the database).

**Body:** `{ "ids": number[], "targetFolder": "/abs/path" }`
**Response:** `{ "ok": true, "errors": [{ id, error }] }`. The target folder is
created if needed and registered in the folder tree.

### `DELETE /api/images`

Soft-delete images (move to trash). **Starred images are protected.**

**Body:** `{ "ids": number[] }`
**Response:** `{ "ok": true, "trashed": number[], "skipped": number[], "errors": [] }`
— `skipped` lists starred ids that were refused.

### `POST /api/images/restore`

Restore trashed images to their original locations.

**Body:** `{ "ids": number[] }`
**Response:** `{ "ok": true, "restored": number[], "errors": [] }`.

### `DELETE /api/images/trash`

Permanently delete from the trash (removes files from disk).

**Body:** `{ "ids": number[] }` — an **empty array (or omitted body) empties the entire trash**.
**Response:** `{ "ok": true, "purged": number, "errors": [] }`.

### `GET /api/images/missing/count`

How many rows point at a file that is currently offline.

**Response:** `{ "missing": 42 }`.

### `DELETE /api/images/missing`

Forget offline images — deletes their rows (metadata and tags cascade) and any
cached thumbnail no longer referenced by another row. Nothing is removed from
the image root; those files are already gone. See [Offline images](#offline-images).

**Body:** `{ "ids": number[] }` to purge specific rows, or an **empty body to
purge every offline row**. Ids that aren't flagged offline are ignored.
**Response:** `{ "ok": true, "purged": number, "thumbnails": number }`.

### Tags on an image

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/images/:id/tags` | — | `string[]` (sorted) |
| `POST /api/images/:id/tags` | `{ "tag": "portrait" }` | `{ "ok": true }` (tag is lower-cased/trimmed) |
| `DELETE /api/images/:id/tags/:tag` | — | `{ "ok": true }` |

---

## Metadata & facets

<a id="facets"></a>
imgmgr parses the SD generation-parameters line (`Steps: …, Sampler: …, CFG scale:
…, Model: …`) out of each image's embedded metadata and stores the discrete fields
as metadata rows. These power the facet filters.

### `GET /api/images/meta/keys`

All distinct metadata keys present in the database.
**Response:** `string[]`.

### `GET /api/images/meta/values?key=<key>`

Distinct values for one metadata key, with match counts — used to build the facet
dropdowns. Only counts non-trashed images.

**Response:** `[{ "value": "Euler a", "n": 9312 }, …]` (up to 500, ordered by count).

To **filter** by these, pass them to `GET /api/images` via the `facets` query
parameter, e.g. `facets={"Model":"perfectdeliberate_XL","Sampler":"DPM++ 2M"}`.

---

## Thumbnails & full images

These return image **bytes**, not JSON.

| Method & path | Description |
| --- | --- |
| `GET /api/thumb/:id` | Cached thumbnail (generated on demand). `Cache-Control: max-age=86400`. |
| `GET /api/full/:id` | The original full-resolution file. `Cache-Control: max-age=3600`. |

Both return `404` for unknown ids.

---

## Folders

### `GET /api/folders`

The full folder list (the client builds the tree from `parent_path`).

**Response:** `[{ "id", "path", "name", "parent_path" }, …]`, ordered by path.

### `POST /api/folders`

Create a folder on disk and register it.

**Body:** `{ "path": "/abs/path/new-folder" }` → `{ "ok": true }`.

---

## Duplicates

### `GET /api/duplicates`

Find duplicate groups. Trashed images are excluded.

**Query:** `type` = `exact` (default) | `seed`.

> The `perceptual` mode was removed — it compared every image against every other
> one (O(n²): ~4.8 billion comparisons at 98k images), blocking the server for
> hours while producing poor groupings. It now returns **`410 Gone`**. For visual
> matches use [`GET /api/images/:id/similar`](#get-apiimagesidsimilar), which
> compares one hash against the library.

**Response:** `{ groups: Group[], total }`. Each `Group` has a `type`, an `images`
array, and (depending on type) a `hash` or `seed`.

### `DELETE /api/duplicates`

Soft-delete the given images (to trash). Starred images are protected.

**Body:** `{ "ids": number[] }`
**Response:** `{ "ok": true, "trashed", "skipped", "errors" }`.

---

## Tags (global)

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/tags` | — | `string[]` — all distinct tags, sorted |
| `POST /api/tags/bulk` | `{ "ids": number[], "tag": "x" }` | `{ "ok": true }` — add a tag to many images |
| `DELETE /api/tags/bulk` | `{ "ids": number[], "tag": "x" }` | `{ "ok": true }` — remove a tag from many images |

---

## Prompt phrases

Recurring phrases mined from positive prompts, used by the sidebar suggestion
panel. **Read-only with respect to your library** — nothing here changes images,
tags or metadata. See [`server/phrases.js`](../server/phrases.js) for how a
prompt is cut into phrases.

### `GET /api/phrases`

| Param | Default | Meaning |
| --- | --- | --- |
| `limit` | `200` | Max phrases returned (capped at 500) |
| `q` | — | Substring filter on the phrase |
| `min` | `0` | Minimum image count |
| `minWords` | `1` | Minimum words per phrase — `2` hides bare nouns like `hair` |

**Response:**

```json
{
  "ready": true,
  "stored": 46977,
  "builtAt": 1786883894628,
  "version": 1,
  "phrases": [
    { "phrase": "gorgeous hips", "count": 34872, "words": 2 },
    { "phrase": "regency era",   "count": 32735, "words": 2 }
  ]
}
```

`ready: false` with an empty `phrases` array means the index has not been built
yet. `count` is the number of images whose prompt uses the phrase.

A phrase that is merely a fragment of a longer, near-equally-common one is
dropped: if `regency era` appears 32,735 times and `era` 33,003, only the
longer phrase is returned.

### `POST /api/phrases/tag`

Promote a phrase to a real tag: add it to every image whose prompt uses it.

**Body:** `{ "phrase": "regency era" }` — must already exist in the index; this is
not a general "tag everything matching arbitrary text" endpoint.
**Response:** `{ "ok": true, "tag": "regency era", "tagged": 32735 }`.

Matching uses the same loose [`phrase:`](#phrase--loose-word-gaps) rule the panel
uses, so the number tagged agrees with the count that was shown. Trashed images
are skipped. The rows are written with `source = 'phrase'`; the tag **name** is
not marked, so it reads, searches and filters exactly like a hand-made tag.
Re-running is a no-op (`INSERT OR IGNORE`).

### `DELETE /api/phrases/tag`

Undo a promotion.

**Body:** `{ "tag": "regency era" }`
**Response:** `{ "ok": true, "tag": "regency era", "removed": 32735 }`.

Scoped to `source = 'phrase'`, so a hand-made tag sharing the name survives.

### `POST /api/phrases/rebuild`

Rebuild the index from every prompt in the library.

**Response:** `{ "status": "ok", "prompts": 97860, "distinct": 87895, "stored": 46977, "ms": 3850 }`,
or `{ "status": "already running" }`.

> Synchronous, and roughly **4 s per 100k prompts** — it blocks the event loop
> for that time. The server also rebuilds automatically at startup, 5 s after
> listening, but only when the index is missing or was written by an older
> `PHRASE_INDEX_VERSION`.

---

## Scanning, events & config

### `POST /api/scan`

Trigger a filesystem re-scan of the image root (incremental, by mtime). Runs in the
background. **Response:** `{ "status": "started" }` or `{ "status": "already running" }`.

### `GET /api/scan/status`

**Response:** `{ "running": boolean }`. Poll this after `POST /api/scan`.

### `GET /api/events`

A **Server-Sent Events** stream. The server emits an `images:changed` event when
the watched folder gains new files, so the client can show a "new images" banner.
The connection is kept alive with periodic comment pings.

```js
const es = new EventSource('/api/events');
es.addEventListener('images:changed', () => { /* refetch */ });
```

### `GET /api/config`

Read-only subset of the server config the client needs.
**Response:** `{ "imageRoot": "…", "thumbnailSize": 220 }`.

---

## Search syntax

By default the `search` parameter matches against **filename** and **positive
prompt**. It supports multiple terms, exclusions, phrases, and per-field prefixes:

| Example | Meaning |
| --- | --- |
| `sunset beach` | contains **both** (space = AND) |
| `sunset -beach` | contains `sunset` but **not** `beach` |
| `"close up"` | the exact phrase `close up` |
| `castle -"low quality"` | `castle`, excluding the phrase `low quality` |
| `caption:castle` | `castle` in the **caption** only |
| `caption:"golden hour"` | the phrase `golden hour` in the caption |
| `dog -caption:cartoon` | `dog` (filename/prompt), excluding `cartoon` captions |
| `prompt:sunset` / `name:00012` | restrict a term to the prompt / filename |
| `phrase:"arabic eyeliner"` | the prompt concept, either spelling (see below) |

**Field prefixes** (`field:term` or `field:"phrase"`) restrict a single term to
one field: `caption`, `prompt`, `name` (alias `file`), `phrase`. Captions are
searched **only** when explicitly prefixed, so they never dilute ordinary prompt
searches. An unrecognised prefix (e.g. `steps:30`) is treated as a literal term.

The `-` operator works attached (`-blurry`) or spaced (`- blurry`). Wildcard
characters (`%`, `_`) are matched literally.

### `phrase:` — loose word gaps

`phrase:` searches the positive prompt like `prompt:` does, except each **space
or hyphen in the term matches any single character**. Prompts mix spellings for
the same concept — `arabic eyeliner` and the Danbooru-style `arabic_eyeliner` —
and [`GET /api/phrases`](#get-apiphrases) folds those into one entry. A literal
search would then contradict the count the panel displayed: measured on a real
library, `prompt:"arabic eyeliner"` found **2,212** images where the panel had
promised **16,263**; `phrase:` finds **16,397**.

This is the prefix the phrase panel emits when you click an entry. Use `prompt:`
when you want an exact, literal match.

---

## Stable pagination

`GET /api/images` uses `limit`/`offset` paging, which is only stable while the
underlying rows stay put. A background scan inserts newly indexed images at the
front of an `mtime-desc` listing, shifting every already-fetched row further
down — so the next `offset` returns rows the client already has, and they appear
twice.

To page safely, **echo the `snapshot` value back as `max_id`**:

1. Request the first page normally. The response includes
   `snapshot` — the highest image id at that moment.
2. Pass `max_id=<snapshot>` on every follow-up page.

Image ids are `AUTOINCREMENT`, so `id <= max_id` freezes the result set against
later inserts regardless of the sort mode. `total` also stays constant, so
"loaded / total" and end-of-list checks stay correct while scrolling. Start a
new listing (omit `max_id`) to pick up images indexed since.

Every sort order additionally ends in `id`, making it a total order — rows that
tie on `mtime`, `filename`, or `favorite` can't otherwise be returned in a
different order between two queries, which would duplicate or skip rows at a
page boundary.

---

## Offline images

When a scan finds that an image file is gone, the row is **flagged, not
deleted**: `missing_at` is set to the time it was first noticed. Removable
drives and network shares come and go, so a vanished path is never treated as
permission to discard a rating, tags, a caption, or the cached thumbnail.

- Offline images stay in normal listings. Filter with `missing=1` / `missing=0`.
- `GET /api/thumb/:id` keeps working — thumbnails are cached by content hash and
  don't need the original.
- `GET /api/full/:id` returns **`410 { "error": "file offline", "path": … }`**,
  since the original genuinely can't be served.
- If the file comes back, the next scan clears the flag automatically. A file
  that reappears at a *different* path is matched by content hash and its row is
  repointed, so nothing is lost to a move either.
- Rows are only ever removed by an explicit `DELETE /api/images/missing`.

Because nothing is deleted automatically, a share that fails to mount cannot
cost you data — worst case every image is flagged offline until it returns.

---

## Trash lifecycle

1. `DELETE /api/images` (or `DELETE /api/duplicates`) moves files into the trash
   directory and flags the rows (`trashed_at` set). Starred images are skipped.
2. Trashed images disappear from all normal listings, counts, `ids`, duplicate
   detection, and similarity search.
3. `GET /api/images?trashed=1` lists them; `POST /api/images/restore` puts them
   back; `DELETE /api/images/trash` erases them from disk permanently.

## Error responses

Endpoints validate their input and return `400 { "error": "…" }` for bad requests
(e.g. missing `ids`), and `404 { "error": "not found" }` for unknown image ids.
Per-item failures during bulk file operations are reported in an `errors` array
in an otherwise-`200` response, so a partial failure doesn't abort the whole batch.
