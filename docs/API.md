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
| `search` | — | Full-text filter over filename + positive prompt. See [Search syntax](#search-syntax). |
| `tag` | — | Only images carrying this tag. |
| `facets` | — | JSON object of generation-param filters, e.g. `{"Model":"x","Sampler":"Euler a"}`. Multiple keys are ANDed. See [Facets](#facets). |
| `trashed` | — | `1` to list **only** trashed images (ignores `folder`/`favorite_min`, sorted by trash time). Omit for normal results. |
| `meta_key` + `meta_value` | — | Legacy single metadata `LIKE` filter (prefer `facets`). |
| `limit` | `100` | Page size. |
| `offset` | `0` | Page offset. |

**Response** `{ images: Image[], total: number }` where `total` is the full match
count (not just this page). Each `Image`:

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
  "trashed_at": null
}
```

```bash
curl 'http://localhost:3000/api/images?search=sunset%20-blurry&sort=fav-desc&limit=50'
curl 'http://localhost:3000/api/images?facets=%7B%22Model%22%3A%22perfectdeliberate_XL%22%7D'
```

### `GET /api/images/counts`

Favorite-level histogram for the current filters — powers the `Min ★` counts.

**Query:** `folder`, `search`, `facets` (same meaning as above).

**Response:** an object keyed by rating → count, e.g. `{ "0": 19254, "5": 1 }`.

### `GET /api/images/ids`

All image ids matching the filters (used by "select all" to cover unloaded pages).

**Query:** `folder`, `favorite_min`, `search`, `tag`, `facets`.

**Response:** `number[]`.

### `GET /api/images/:id`

Full record for one image (all columns, including `phash`, `thumbnail_path`,
`original_path`, `indexed_at`).

**Response:** a single image object, or `404 { "error": "not found" }`.

### `GET /api/images/:id/metadata`

All raw metadata key/value pairs for the image (EXIF tags, `UserComment`,
`parameters`, and the extracted generation params like `Model`, `Sampler`).

**Response:** `[{ "key": "Sampler", "value": "Euler a" }, …]`.

### `GET /api/images/:id/similar`

Find visually similar images using the perceptual hash (dHash).

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

**Query:** `type` = `exact` (default) | `perceptual` | `seed`;
`threshold` (perceptual only, default `8` bits).

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

The `search` parameter matches against **filename** and **positive prompt** and
supports multiple terms, exclusions, and phrases:

| Example | Meaning |
| --- | --- |
| `sunset beach` | contains **both** (space = AND) |
| `sunset -beach` | contains `sunset` but **not** `beach` |
| `"close up"` | the exact phrase `close up` |
| `castle -"low quality"` | `castle`, excluding the phrase `low quality` |

The `-` operator works attached (`-blurry`) or spaced (`- blurry`). Wildcard
characters (`%`, `_`) are matched literally.

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
