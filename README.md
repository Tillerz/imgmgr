# imgmgr

A browser-based image manager built for large collections of AI-generated images (Stable Diffusion and compatible tools). Runs as a local Node.js server with a React frontend.

![Dark UI with tile grid, folder tree, and star filters](/resources/images/image-list.webp)

![Image View](/resources/images/image-view.webp)

![Duplicate Finder](/resources/images/duplicate-finder.webp)

## Features

- **Tile grid** with WebP thumbnails, infinite scroll, and lazy loading
- **Full-size lightbox** with EXIF/metadata sidebar (copy-paste friendly)
- **Folder tree** — collapsible, with drag-and-drop move support
- **Star ratings** (0–5) with per-level counts in the filter bar
- **Multi-select** — select tiles, then move to a folder or delete
- **Duplicate finder** — three modes:
  - *Exact* — identical file content (MD5 hash)
  - *Visual* — perceptually similar images (dHash, slow!)
  - *Seed* — same generation seed in the filename (might match non-similar images!)
- **Live updates** — watches today's output folder via SSE; a banner appears when new images arrive
- **Metadata search** — filter by filename, prompt text, or arbitrary EXIF key/value
- Reads SD metadata from PNG `tEXt` chunks and WebP EXIF (positive prompt, negative prompt, seed, steps, etc.)

## Requirements

- **Node.js** 20+ (uses `--watch` for dev mode)
- **npm** 9+
- Linux / macOS / WSL2

> **WSL2 note:** If your images are on a DrvFs mount (e.g. `/mnt/d/`), the file watcher uses polling (`usePolling: true`) because inotify does not work across the Windows filesystem boundary. Set `watchInterval` in `config.json` to balance responsiveness vs CPU.

## Setup

```bash
git clone https://github.com/tillerz/imgmgr
cd imgmgr
npm install
```

Edit `config.json` to point at your image root:

```json
{
  "port": 3000,
  "imageRoot": "/path/to/your/images",
  "thumbnailSize": 220,
  "thumbnailQuality": 82,
  "cacheDir": ".cache",
  "supportedExtensions": ["png", "webp"],
  "scanOnStart": true,
  "watchForChanges": false,
  "watchInterval": 5000
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `imageRoot` | `/mnt/sd/images` | Root directory scanned for images |
| `thumbnailSize` | `220` | Max thumbnail dimension in pixels |
| `thumbnailQuality` | `82` | WebP thumbnail quality (1–100) |
| `cacheDir` | `.cache` | Directory for the SQLite DB and thumbnail cache (relative to project root) |
| `supportedExtensions` | `["png","webp"]` | File types to index |
| `scanOnStart` | `true` | Run a full scan when the server starts |
| `watchForChanges` | `false` | Enable live file watching |
| `watchInterval` | `5000` | Polling interval in ms (used on DrvFs/WSL2 mounts) |

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
- Use the **search bar** to filter by filename or prompt text.
- Use the **Min ★** buttons to show only images at or above a star rating. Counts are shown next to each button.
- The **sort dropdown** supports date, name, and star rating in both directions.

### Viewing an image

Click any thumbnail to open the lightbox. The right panel shows:
- Full EXIF/metadata key-value pairs (click any value to copy)
- Positive and negative prompts
- Star rating control

Navigate with the **← →** arrow buttons or keyboard arrow keys.

### Rating images

Click the stars in the lightbox sidebar, or hover a tile and use the star overlay directly on the grid.

### Multi-select and bulk actions

- Click the **checkbox button** in the top-left corner of a tile to select it (or click again to deselect).
- Use **All** / **None** in the toolbar to select or clear the whole page.
- With images selected, **Move N →** opens a folder picker; **Delete N** removes them from disk and the database.

### Moving images

Drag a tile and drop it onto a folder in the tree, or use the **Move N →** button in the toolbar after selecting images.

### Duplicate finder

Click **Duplicates** in the toolbar to open the duplicate panel.

| Mode | How it works |
|------|-------------|
| **Exact** | Groups images with identical MD5 file hashes |
| **Visual** | Groups images whose perceptual hash (dHash) differs by ≤ 8 bits |
| **Seed** | Groups images sharing the same generation seed (last number in the filename, e.g. `00042-1827738702.png`) |

Inside each group, click tiles to select them, or use **Keep oldest, select rest** to pre-select all but the first. Then click **Delete N selected** to remove them.

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

## File structure

```
imgmgr/
├── server/
│   ├── index.js          # Express app, Vite middleware, SSE endpoint
│   ├── config.js         # Loads config.json
│   ├── db.js             # SQLite schema and connection
│   ├── scanner.js        # Full directory scan + file indexing
│   ├── meta.js           # PNG tEXt and WebP EXIF metadata extraction
│   ├── thumbnails.js     # Sharp thumbnail generation, pHash, file hash
│   ├── duplicates.js     # Exact / perceptual / seed duplicate detection
│   ├── watcher.js        # Chokidar file watcher (today's folder only)
│   ├── events.js         # SSE broadcast utility
│   └── routes/
│       ├── images.js     # GET/PATCH/DELETE image endpoints
│       ├── folders.js    # Folder listing and creation
│       └── duplicates.js # Duplicate find and delete endpoints
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
