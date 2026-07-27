# ImgMgr

A browser-based image manager built for large collections of AI-generated images (Stable Diffusion and compatible tools). Runs as a local Node.js server with a React frontend.

![Dark UI with tile grid, folder tree, and star filters](/resources/images/image-list.webp)

![Image View](/resources/images/image-view.webp)

![Duplicate Finder](/resources/images/duplicate-finder.webp)

## Features

- **Virtualized tile grid** — only the visible rows are rendered, so it stays fast with tens of thousands of images; pages stream in as you scroll
- **Full-size lightbox** with a rich metadata sidebar — separate **Prompt / Negative prompt / Template** sections that are collapsible and resizable, LoRA and wildcard highlighting, a resizable panel width, and the generation params surfaced first
- **Folder tree** — collapsible, with drag-and-drop move support, newest folders first
- **Star ratings** (0–5) with per-level counts in the filter bar; rate from the grid, the lightbox, or the `0`–`5` keys
- **Keyboard-driven lightbox** — arrow keys walk the *entire* result set (pages load as you go), `0`–`5` rate, `F` toggles 5★, `Space` advances, `Del` deletes and advances
- **Copy prompt** — one click copies an image's positive prompt, negative prompt, or template, from a tile's hover button or the lightbox
- **Trash & undo** — deletes are recoverable: images move to a trash you can restore from, and an Undo appears right after deleting
- **Delete protection** — starred images can't be deleted from any view
- **Multi-select** — select images, then move to a folder, delete, tag, or **bulk-rate** them
- **Metadata facet filters** — filter by **Model**, **Sampler**, or **Steps** dropdowns (extracted from the SD generation parameters), combinable with search and folders
- **Find similar** — from the lightbox, discover visually similar images using the perceptual hash
- **Duplicate finder** — three modes:
  - *Exact* — identical file content (MD5 hash)
  - *Visual* — perceptually similar images (dHash, slow!)
  - *Seed* — same generation seed in the filename (might match non-similar images!)
- **Live updates** — watches today's output folder via SSE; a banner appears when new images arrive
- **Metadata search** — filter by filename, prompt text, or arbitrary EXIF key/value, with multi-term AND, exclusions (`-term`), and quoted phrases
- Reads SD metadata from PNG `tEXt` chunks and WebP/JPEG EXIF (positive prompt, negative prompt, seed, steps, etc.)

## Requirements

- **Node.js** 22+ (uses `--watch` for dev mode)
- **npm** 11+ (bundled with Node 22; npm 12 also supported)
- Linux / macOS / WSL2

> **WSL2 note:** If your images are on a DrvFs mount (e.g. `/mnt/d/`), the file watcher uses polling (`usePolling: true`) because inotify does not work across the Windows filesystem boundary. Set `watchInterval` in `config.json` to balance responsiveness vs CPU.

## Setup

```bash
git clone https://github.com/tillerz/imgmgr
cd imgmgr
npm install
```

> **npm 12 note:** npm 12 blocks package install scripts by default. The native dependencies (`better-sqlite3`, `sharp`, `esbuild`) are pre-approved via the `allowScripts` field in `package.json`, so `npm install` builds them automatically. After upgrading any of those packages, re-approve with `npm install-scripts approve <pkg>`.

Edit `config.json` to point at your image root:

```json
{
  "port": 3000,
  "imageRoot": "/path/to/your/images",
  "thumbnailSize": 220,
  "thumbnailQuality": 82,
  "cacheDir": ".cache",
  "supportedExtensions": ["png", "webp", "jpg", "jpeg"],
  "scanOnStart": true,
  "watchForChanges": false,
  "watchInterval": 5000
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `imageRoot` | `~/sd/imgmgr` | Root directory scanned for images |
| `thumbnailSize` | `220` | Max thumbnail dimension in pixels |
| `thumbnailQuality` | `82` | WebP thumbnail quality (1–100) |
| `cacheDir` | `.cache` | Directory for the SQLite DB and thumbnail cache (relative to project root) |
| `supportedExtensions` | `["png","webp","jpg","jpeg"]` | File types to index (JPEG/`.jpg` read SD params from EXIF `UserComment`) |
| `scanOnStart` | `true` | Run a full scan when the server starts |
| `watchForChanges` | `false` | Enable live file watching |
| `watchInterval` | `5000` | Polling interval in ms (used on DrvFs/WSL2 mounts) |
| `trashDirName` | `trash` | Sub-directory of `cacheDir` where deleted images are moved (recoverable) |

## Running

### Development (hot reload)

```bash
npm run dev
```

Starts the Express server with `node --watch`. Vite runs in middleware mode on the same port — no separate frontend process needed.

Open **http://localhost:3000**

### Production

```bash
npm run build   # compiles the React app into dist/
npm start       # serves dist/ via Express
```

## Usage

### Browsing

- The **folder tree** on the left lists all indexed folders. Click a folder to filter. Click the **▸** arrow to expand/collapse subfolders.
- Use the **search bar** to filter by filename or positive-prompt text (see [Search syntax](#search-syntax) below).
- Use the **Min ★** buttons to show only images at or above a star rating. Counts are shown next to each button.
- The **Model / Sampler / Steps** dropdowns filter by the SD generation parameters (see [Facet filters](#facet-filters)). They combine with search, folder, and each other.
- The **sort dropdown** supports date, name, and star rating in both directions.

#### Facet filters

imgmgr parses the generation parameters (the `Steps: …, Sampler: …, CFG scale: …, Model: …` line) out of each image's embedded metadata and stores them as discrete, filterable fields. The toolbar exposes **Model**, **Sampler**, and **Steps** dropdowns — each option shows how many images match — so you can quickly narrow to, say, everything made with a particular checkpoint and sampler. Selecting values in more than one dropdown ANDs them together, and the star-rating counts update to reflect the active facets.

Existing libraries are backfilled automatically on first launch after upgrading (a one-time pass over the database); newly scanned images get the fields during indexing.

#### Search syntax

The search bar matches against both the **filename** and the **positive prompt**. It supports multiple terms, exclusions, and phrases:

| Type this | Matches images that… |
| --- | --- |
| `sunset beach` | contain **both** `sunset` **and** `beach` (space = AND) |
| `sunset -beach` | contain `sunset` but **not** `beach` |
| `"close up"` | contain the exact phrase `close up` |
| `"close up" -blurry` | contain the phrase `close up` but not `blurry` |
| `castle + dragon - modern` | contain `castle` **and** `dragon`, but **not** `modern` |

- **Space means AND** — every included term must be present.
- **`-` excludes** a term. It works attached (`-blurry`) or spaced (`- blurry`), and can be combined with quotes (`-"low quality"`).
- **`+` is optional** and simply marks an included term; a plain space already implies it.
- **Quotes** group multiple words into a single phrase. Without quotes, each word is matched independently.
- Terms are matched literally, so wildcard characters (`%`, `_`) and hyphenated words like `close-up` are treated as-is.

### Viewing an image

Click any thumbnail to open the lightbox. The right panel shows:

- **Tags** (add/remove them right at the top)
- Dimensions, size, date, and folder
- **Prompt**, **Negative prompt**, and **Template** sections, each with its own **Copy** button
- **EXIF / Metadata** — the generation params come first in a fixed order (**Model, Sampler, Steps, CFG scale, UNET, LoRA networks, Seed**), then everything else
- A collapsed **UserComment (raw)** section holding the unparsed metadata string
- Star rating control (top bar)

The lightbox top bar also has a **🔍 Similar** button — see [Find similar images](#find-similar-images).

#### Reading long prompts

The metadata panel is built for triaging prompts:

- **Collapse / expand** any of Prompt, Negative prompt, Template, and UserComment by clicking its heading. The collapsed/expanded state is remembered across images and sessions.
- **Resize** an expanded prompt field by dragging its bottom edge, and **resize the whole panel's width** by dragging the divider between the image and the sidebar (also remembered).
- **LoRA tags** (`<lora:…>`) are highlighted in light green and **wildcards** (`__word__`) in cyan, in all three prompt fields.
- An empty or missing Negative prompt is hidden entirely, and the Template is shown as its own section rather than being mixed into the negative prompt.

Navigate with the **← →** arrow buttons or keyboard arrow keys. Navigation spans the **entire current result set** — additional pages load automatically as you move past the images already fetched, so you can arrow all the way to the last (or first) image without scrolling the grid first. The counter shows your position within the full total (e.g. `198 / 79158`).

#### Lightbox keyboard shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Previous / next image (loads more as needed) |
| `Space` | Advance to the next image |
| `0`–`5` | Set the star rating (`0` clears it) |
| `F` | Toggle 5★ on/off |
| `Del` | Delete the current image (to trash) and jump to the next |
| `Esc` | Close the lightbox |

Each prompt section (Prompt, Negative prompt, Template) has its own **Copy** button, and every tile shows a **copy-prompt** button (⧉) on hover — one click copies that image's positive prompt to the clipboard.

### Find similar images

Open any image in the lightbox and click **🔍 Similar** in the top bar. imgmgr compares the image's perceptual hash (dHash) against the whole library and shows every visually similar image, nearest first. A banner indicates you're in similar-search mode — click **← Back to all images** to return. This reuses the same hashing that powers the duplicate finder, so it's essentially free.

### Rating images

Click the stars in the lightbox sidebar, hover a tile and use the star overlay directly on the grid, or press the `0`–`5` keys (or `F` for 5★) while viewing an image. To rate many at once, select images and use the **Rate:** star control in the toolbar (the **0★** button clears the rating on the selection).

### Multi-select and bulk actions

- Click the **checkbox button** in the top-left corner of a tile to select it (or click again to deselect).
- Use **All** / **None** in the toolbar to select or clear the whole page.
- With images selected, **Rate:** sets a star rating on all of them, **Move N →** opens a folder picker, **Tag N →** adds/removes a tag, and **Delete N** moves them to the trash.

> **Starred images are protected from deletion.** Any image with a rating of 1★ or higher is refused by the delete routes — in bulk delete, the lightbox `Del` shortcut, and the duplicate finder alike. You'll see a notice reporting how many were skipped; remove the stars first if you really want to delete them.

### Trash & undo

Deletes are **recoverable**. Instead of erasing files, imgmgr moves them into a trash folder (under `cacheDir`, so it works even when the image root is read-only) and hides them from all views.

- Right after deleting, an **Undo** toast appears — click it to put the images straight back.
- Click **🗑 Trash** in the header to browse deleted images. There you can **Restore** selected images to their original folders, **Delete permanently** (removes them from disk for good), or **Empty trash**.
- The duplicate finder also deletes to the trash, so its removals are recoverable too.

### Moving images

Drag a tile and drop it onto a folder in the tree, or use the **Move N →** button in the toolbar after selecting images.

### Duplicate finder

Click **Duplicates** in the toolbar to open the duplicate panel.

| Mode | How it works |
|------|-------------|
| **Exact** | Groups images with identical MD5 file hashes |
| **Visual** | Groups images whose perceptual hash (dHash) differs by ≤ 8 bits |
| **Seed** | Groups images sharing the same generation seed (last number in the filename, e.g. `00042-1827738702.png`) |

Selection spans every group at once. Use the action bar at the top of the panel to **Keep oldest in all, select rest** (across all groups), **Clear**, or **Delete N selected** — so you can clean up every folder's duplicates in one pass instead of group by group. Each group also has its own **Keep oldest, select rest** button, and you can click individual tiles to fine-tune the selection. Deletions go to the trash, so they're recoverable.

**NOTE**: The seed duplicate detection only works automatically when you use software like [SDNext](https://github.com/vladmandic/sdnext) with these settings:
```
Settings/Image Paths:

  Images filename pattern: [job_timestamp]-[seed]
```

### Live updates

Set `"watchForChanges": true` in `config.json` and restart the server. imgmgr watches today's dated subfolder (`YYYY/YYYY-MM-DD/`) for new files. When a new image is detected a banner appears at the top of the grid — click it to refresh.

**NOTE**: this feature expects you to have a folder structure like this:

```
2024/
2025/
2026/
├── 2026-03-30/
├── 2026-04-23/
├── 2026-04-25/
```

Create a folder each day with the full timestamp, like 2026-04-25.
If you use a software like [SDNext](https://github.com/vladmandic/sdnext) to create images, you can establish this automatically with these settings:

```
Settings/Image Paths:

  [ ] Numbered filenames
  [x] Save images to a subdirectory
  Directory name pattern: [date]

  Base images folder: /some path here/2026 (adjust this to the current year)
```

### Triggering a manual scan

`POST /api/scan` re-indexes the entire `imageRoot`. This is also called automatically on startup when `scanOnStart` is true. Scan progress is logged to the server console.

## API

imgmgr is fully driven by a small JSON HTTP API (the web client is just a consumer of it). Every endpoint — listing/filtering, ratings, tags, trash, facets, similarity search, duplicates, scanning, and the SSE live-update stream — is documented in **[docs/API.md](docs/API.md)**.

## File structure

```
imgmgr/
├── server/
│   ├── index.js          # Express app, Vite middleware, SSE endpoint
│   ├── config.js         # Loads config.json, derives TRASH_DIR
│   ├── db.js             # SQLite schema, migrations, connection
│   ├── migrate.js        # One-time backfill of generation-param facets
│   ├── scanner.js        # Full directory scan + file indexing
│   ├── meta.js           # PNG tEXt / WebP+JPEG EXIF + gen-param extraction
│   ├── thumbnails.js     # Sharp thumbnail generation, pHash, file hash
│   ├── duplicates.js     # Exact / perceptual / seed duplicate detection
│   ├── trash.js          # Soft-delete: trash / restore / purge
│   ├── watcher.js        # Chokidar file watcher (today's folder only)
│   ├── events.js         # SSE broadcast utility
│   └── routes/
│       ├── images.js     # Image list/filter, ratings, tags, trash, facets, similar
│       ├── folders.js    # Folder listing and creation
│       ├── duplicates.js # Duplicate find and delete endpoints
│       └── tags.js       # Global tag listing and bulk add/remove
├── client/
│   ├── src/
│   │   ├── App.jsx       # Root component, state, SSE hook
│   │   ├── api.js        # fetch wrappers for all API endpoints
│   │   └── components/
│   │       ├── Toolbar.jsx
│   │       ├── FolderTree.jsx
│   │       ├── TileGrid.jsx
│   │       ├── ImageViewer.jsx
│   │       ├── StarRating.jsx
│   │       └── DuplicatePanel.jsx
│   └── style.css
├── docs/
│   └── API.md            # HTTP API reference
├── config.json
└── package.json
```

## License

Shield: [![CC BY-NC 4.0][cc-by-nc-shield]][cc-by-nc]

This work is licensed under a
[Creative Commons Attribution-NonCommercial 4.0 International License][cc-by-nc].

[![CC BY-NC 4.0][cc-by-nc-image]][cc-by-nc]

[cc-by-nc]: https://creativecommons.org/licenses/by-nc/4.0/
[cc-by-nc-image]: https://licensebuttons.net/l/by-nc/4.0/88x31.png
[cc-by-nc-shield]: https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg
