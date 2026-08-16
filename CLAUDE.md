# imgmgr

Browser-based image manager for large libraries of AI-generated images (SDNext / Stable Diffusion).
Local Node server + React SPA. ~3.8k lines. No tests, no CI, single developer.

## Commands

```bash
npm run dev     # Express + Vite middleware on one port (http://localhost:3000)
npm run build   # compile client into dist/
npm start       # serve dist/ via Express
```

**The user runs the server themselves.** Do not start long-lived servers. For checks, hit the
user's instance if it is up, or use `scripts/apicheck.mjs` (throwaway port, no scan).

**`node --watch` does not hot-reload here** (WSL2 inotify). After editing `server/**`, tell the
user to restart. Client changes are picked up by Vite normally.

## Layout

```
server/           Express API + all domain logic
  index.js        entry: app wiring, thumb/full/scan/events/config routes, Vite middleware
  config.js       config.json + defaults -> `config`, derives TRASH_DIR
  db.js           better-sqlite3 handle, schema, ALTER-based migrations
  scanner.js      runScan: walk -> reconcileMoves -> indexFile -> syncMissingFlags
  meta.js         PNG tEXt / WebP+JPEG EXIF -> prompts + generation params
  thumbnails.js   sharp thumbnails, DCT pHash, md5, hammingDistance
  duplicates.js   exact / seed grouping (perceptual mode removed — was O(n²))
  trash.js        soft delete: trash / restore / purge
  caption.js      SDNext VQA captioning
  migrate.js      one-time backfills (guarded, run at startup)
  watcher.js      chokidar on today's dated folder (opt-in)
  events.js       SSE client registry + broadcast
  routes/         images.js (the big one), folders.js, duplicates.js, tags.js
client/
  style.css       base + "Classic" theme (the tokens live in `:root`)
  theme-modern.css  "Modern" theme, entirely scoped to html[data-theme="modern"]
client/src/
  main.jsx        React root + QueryClient
  App.jsx         all app state, pagination, bulk actions
  api.js          thin fetch wrapper per endpoint — the only place URLs live
  components/     Toolbar, FolderTree, TileGrid, ImageViewer, DuplicatePanel, StarRating
docs/API.md       full HTTP API reference — update when routes change
```

Generated/ignored: `node_modules/`, `dist/`, `.cache/` (DB + thumbs + trash), `config.json`, `.claude/`.

## Architecture

**Layered, not MVC/Clean.** Deliberately flat — no ORM, no DI, no service/repository layer.

```
React component
  -> client/src/api.js          (fetch wrapper)
  -> Express route              (validates, builds SQL, or calls a domain module)
  -> domain module              (trash / duplicates / meta / thumbnails / caption)
  -> db.js                      (single shared better-sqlite3 handle)
  -> .cache/imgmgr.db
```

Boundaries that are real:

- **`db.js` is the only database handle.** Every module imports the same instance. Calls are
  **synchronous** (better-sqlite3) — no `await` on queries; wrap multi-row writes in
  `db.transaction(...)()`.
- **`api.js` is the only place client-side URLs exist.** Add endpoints there, not in components.
- **Routes hold SQL directly** (`routes/images.js`). This is intentional; don't introduce a
  repository layer without asking.
- **Filesystem writes go through `trash.js` or the move route**, never ad hoc, because of the
  read-only root below.
- **Single port**: Vite runs as Express middleware in dev, static `dist/` in prod. The proxy in
  `vite.config.js` only applies to a standalone `vite` process, which is not the normal workflow.

## Invariants — read before changing behaviour

- **`imageRoot` is read-only** (`/mnt/sd/images`). Never write there. Trash lives in
  `.cache/trash`; cross-device moves need the EXDEV copy+unlink fallback (see `trash.js`).
- **An image's identity is its `path`** (`images.path` UNIQUE), not its hash. `file_hash` (md5)
  keys thumbnails and drives move reconciliation.
- **Nothing is ever auto-deleted.** A vanished file gets `missing_at` set and stays browsable on
  its cached thumbnail. Only `DELETE /api/images/missing` removes rows. Keep it that way — it is
  what makes an unmounted share harmless.
- **Moved/renamed files are matched by content hash** before indexing and flagging
  (`reconcileMoves`), so ratings/tags/captions survive an external `mv`.
- **Starred images (favorite > 0) are protected** from every delete path.
- **There is no auth**, so writes are gated on `Origin` (`config.allowedOrigins`) and any path in a
  request body must pass `isInsideImageRoot()` from `config.js`. Use that helper for every new
  endpoint that takes a path or writes to disk.
- **Every outbound HTTP call needs a timeout.** Node's `fetch` has none; `caption.js` uses
  `AbortSignal.timeout(config.captionTimeoutMs)`.
- **Nothing may scale as O(n²) over the library.** The perceptual duplicate mode was removed for
  exactly this (4.8 billion comparisons, ~2 h of frozen single-threaded server).
- **Pagination needs the `max_id` snapshot** and every sort must end in `i.id`, or a background
  scan shifts offsets and rows repeat. See "Stable pagination" in `docs/API.md`.
- **Prompts: trust the raw source, not the DB columns.** `images.positive_prompt` /
  `negative_prompt` can be polluted by tool quirks; the lightbox re-parses `UserComment` /
  `parameters` client-side (`parseSource` in `ImageViewer.jsx`). When a raw source exists, use its
  parse even if a field is empty.
- **Captions are searched only via the `caption:` prefix**, never by a bare search term.
- **npm 12 blocks install scripts**; native deps are pre-approved in `package.json` `allowScripts`.
  After bumping `better-sqlite3` / `sharp` / `esbuild`, update that map.

## Migrations

Startup runs guarded, one-time backfills from `migrate.js`. Each has its own version marker; bump
it to force a re-run.

| Marker | Now | What |
| --- | --- | --- |
| `PRAGMA user_version` | 1 | discrete generation params for facet filters |
| `app_meta.phash_version` | 2 | pHash recompute after switching dHash -> DCT |
| `app_meta.prompt_fix_version` | 1 | re-extract prompts + raw metadata |

Schema changes use `PRAGMA table_info` + `ALTER TABLE` in `db.js` (see `caption`, `missing_at`).

## Working on this safely

- **Never import `server/index.js`** to check that code loads — it starts a listener and a scan.
  Import the specific module, or run `node scripts/apicheck.mjs`.
- **The live DB is the user's real library** (~98k images). To test DB behaviour, use a
  `BEGIN` / `ROLLBACK` sandbox — see the `imgmgr-safe-testing` skill for the pattern.
- `node scripts/dbstat.mjs` prints schema + counts + migration state without hand-writing SQL.
- Update `docs/API.md` and `README.md` when endpoints or user-facing behaviour change.
