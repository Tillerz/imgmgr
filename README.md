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
- **Keyboard-driven lightbox** — arrow keys walk the *entire* result set (pages load as you go), `0`–`5` rate, `F` toggles 5★, `Space` advances, `Del` deletes and advances, `I` hides the info panel
- **Slideshow** — play the current view, your selection, or the whole library full screen, 1–20 s per image, looping back to the start
- **Picks up where you left off** — the grid remembers your scroll position per view across reloads
- **Collapsible panels** — hide the folder tree (`B`) and the metadata sidebar (`I`) to view images on the full screen
- **Copy prompt** — one click copies an image's positive prompt, negative prompt, or template, from a tile's hover button or the lightbox
- **Trash & undo** — deletes are recoverable: images move to a trash you can restore from, and an Undo appears right after deleting
- **Offline-media friendly** — if a drive or network share goes away, those images stay browsable (cached thumbnails, ratings, tags and metadata intact) and are just badged as offline; nothing is ever deleted without you asking
- **Delete protection** — starred images can't be deleted from any view
- **Multi-select** — select images, then move to a folder, delete, tag, or **bulk-rate** them
- **Metadata facet filters** — filter by **Model**, **Sampler**, or **Steps** dropdowns (extracted from the SD generation parameters), combinable with search and folders
- **Find similar** — from the lightbox, discover visually similar images using a DCT-based perceptual hash, with an adjustable strictness slider
- **AI captions (VQA)** — generate a natural-language caption for a single image or a whole selection via an [SDNext](https://github.com/vladmandic/sdnext) server; captions are stored in the database and separately searchable
- **Duplicate finder** — two modes:
  - *Exact* — identical file content (MD5 hash)
  - *Seed* — same generation seed in the filename (might match non-similar images!)
- **Live updates** — watches today's output folder via SSE; a banner appears when new images arrive
- **Metadata search** — filter by filename, prompt text, or arbitrary EXIF key/value, with multi-term AND, exclusions (`-term`), and quoted phrases; target a single field with `caption:` / `prompt:` / `name:` prefixes
- **[Prompt phrases](#prompt-phrases)** — the concepts recurring most in your prompts, counted and clickable, so you can browse the library instead of guessing search terms
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
  "watchInterval": 5000,
  "sdnextUrl": "http://127.0.0.1:7860",
  "captionModel": "Google Gemma 3 4B"
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
| `sdnextUrl` | `http://127.0.0.1:7860` | SDNext server used for AI captioning (its `/sdapi/v1/vqa` endpoint) |
| `captionModel` | `Google Gemma 3 4B` | VQA model name requested for captions (must exist on the SDNext server) |
| `captionQuestion` | `describe the image` | Prompt/question sent to the caption model |
| `captionSystem` | *(see `config.js`)* | System prompt sent to the caption model |
| `captionTimeoutMs` | `300000` | Give up on a caption request after this long (5 min). A cold model load is slow, but without a limit a wedged SDNext would hang the request forever |
| `allowedOrigins` | localhost/127.0.0.1 on `port` | Browser origins allowed to make **state-changing** requests. See [Access control](#access-control) |

### Access control

imgmgr has no login — it assumes a local, trusted machine. But a browser will happily send requests to `localhost` on behalf of *any* page you have open, so the API restricts who may change things:

- **Reads** (`GET`/`HEAD`) are open.
- **Writes** (`POST`/`PATCH`/`DELETE`) are refused with `403` unless the request's `Origin` is in `allowedOrigins`, or there is no `Origin` at all (curl, scripts, the server itself).
- **Filesystem paths in a request body** (`targetFolder` when moving, `path` when creating a folder) must resolve **inside `imageRoot`**, so the API can't be used to write elsewhere on the machine.

By default `allowedOrigins` covers `http://localhost:<port>`, `http://127.0.0.1:<port>` and the IPv6 equivalent. If you open the UI on another address (a LAN hostname, say), add it:

```json
{ "allowedOrigins": ["http://localhost:3000", "http://my-nas.local:3000"] }
```

Set it to `["*"]` to disable the check entirely. Not recommended — that restores the state where any website could drive your API.

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
- Use the **★** buttons to filter by rating. Counts are shown next to each button, and they respect the other active filters.
  - The **≥ ★** / **= ★** button flips between *this rating and up* and *exactly this rating* — handy when triaging, e.g. "show me only the 3-star ones".
  - **☆ N** shows only unrated images.
- The **Caption** dropdown narrows to images that do or don't have an [AI caption](#ai-captions) yet — the quickest way to see what's left to caption.
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
| `caption:castle` | have `castle` in the **caption** only |
| `caption:"golden hour"` | have the phrase `golden hour` in the caption |
| `dog -caption:cartoon` | match `dog` (filename/prompt) but exclude `cartoon` captions |
| `phrase:"arabic eyeliner"` | use that prompt concept, however it is spelled |

- **Space means AND** — every included term must be present.
- **`-` excludes** a term. It works attached (`-blurry`) or spaced (`- blurry`), and can be combined with quotes (`-"low quality"`).
- **`+` is optional** and simply marks an included term; a plain space already implies it.
- **Quotes** group multiple words into a single phrase. Without quotes, each word is matched independently.
- **Field prefixes** restrict a single term to one field: `caption:`, `prompt:`, `name:` (alias `file:`), or `phrase:`. Unprefixed terms search filename + prompt as usual, and [captions](#ai-captions) are searched **only** when you explicitly write `caption:`, so they never dilute an ordinary prompt search. An unrecognised prefix (e.g. `steps:30`) is treated as a literal term.
- **`phrase:` is the forgiving one.** It searches the prompt like `prompt:` does, but each space or hyphen matches any single character, so `phrase:"arabic eyeliner"` also finds the Danbooru-style `arabic_eyeliner`. This is what the [phrase panel](#prompt-phrases) uses. Use `prompt:` when you want an exact match.
- Terms are otherwise matched literally, so wildcard characters (`%`, `_`) and hyphenated words like `close-up` are treated as-is.

### Viewing an image

Click any thumbnail to open the lightbox. The right panel shows:

- **Tags** (add/remove them right at the top)
- Dimensions, size, date, and folder
- **Prompt**, **Negative prompt**, and **Template** sections, each with its own **Copy** button
- A collapsible **Caption** section with a **Generate caption** button (see [AI captions](#ai-captions))
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
| `I` | Show/hide the metadata panel |
| `P` | Pause / resume the slideshow |
| `Del` | Delete the current image (to trash) and jump to the next |
| `Esc` | Close the lightbox (also stops a slideshow) |

Each prompt section (Prompt, Negative prompt, Template) has its own **Copy** button, and every tile shows a **copy-prompt** button (⧉) on hover — one click copies that image's positive prompt to the clipboard.

### Slideshow

Set the two controls in the toolbar, then press **▶ Slideshow**:

- **Scope** — *This view* plays exactly what the grid is showing, so it respects the selected folder, search, star filter and facets. *All images* ignores every filter and plays the whole library. *Selected* plays only the images you've ticked, in grid order (greyed out until you select something).
- **Speed slider** — 1 to 20 seconds per image.

Playback opens the lightbox and starts at the image you already have open, or the first one you selected, or the very first image. When it reaches the end it **loops back to the start**.

While it runs: **⏸ Pause** / **■ Stop** sit in the lightbox top bar, `P` or `Space` pauses and resumes, the arrow keys still step manually, and `Esc` closes the lightbox and stops the slideshow. Rating with `0`–`5` keeps working as images go by.

> Press `I` first to hide the metadata panel (and `B` before opening, to hide the folder tree) for a clean full-screen show.

### Themes

The **Theme** picker at the right of the header switches the visual style. Your choice is remembered, and applied before first paint so a reload doesn't flash the other theme.

| Theme | Look |
| --- | --- |
| **Classic** | The original dark UI — compact, 6px radii, solid panels |
| **Modern** | Hypermodern dark: near-black `#080808`, hairline translucent borders instead of shadows, radial backlighting, fluid type, and lift-on-hover micro-interactions |

Themes are plain CSS. `client/style.css` holds the base and Classic; `client/theme-modern.css` layers Modern on top, scoped entirely to `html[data-theme="modern"]`, so it has no effect until selected. To add your own, copy the modern file, scope it to a new `data-theme` value, and add an `<option>` to the picker in `App.jsx`.

The Modern theme honours `prefers-reduced-motion` — the lift and scale effects are dropped if your system asks for less animation.

### Hiding the panels

Both side panels get out of the way when you want the screen for the images:

- **Folder tree** — the **‹ Hide** button at its top, or the `B` key. A thin strip stays on the left; click it to bring the tree back.
- **Metadata panel** — the **ℹ Info** button in the lightbox top bar, or the `I` key.

Both remember their state across sessions.

### Where you left off

The grid remembers its scroll position and restores it when you come back — per view, so changing folder, search or filters starts at the top as you'd expect, while returning to a view you were reading puts you back in place. If the saved spot is deep into the library, imgmgr pulls the pages needed to reach it (bounded, so a stale position can't page through everything).

### Prompt phrases

At the bottom of the folder sidebar, **Prompt phrases** lists the phrases that recur most often across your library, with the number of images using each. Click one to filter the grid by it. It's a way to *browse* what your prompts actually contain instead of guessing at a search term — and to notice concepts you'd forgotten you use.

- **Filter phrases…** narrows the list by substring.
- **2+ words only** (on by default) hides bare nouns like `hair` or `eyes` in favour of phrases that describe something: `regency era`, `blurred background`, `arabic eyeliner`.
- **Rebuild** re-reads every prompt. Do this after importing a batch of new images; the index is not updated automatically by a scan.

Clicking a phrase writes nothing — it only fills the search bar with a `phrase:` term, which you can then edit or combine with anything else.

#### Turning a phrase into a real tag

Hover a phrase and click **+** to promote it: the phrase becomes an ordinary tag, applied to every image whose prompt uses it. It then appears in the tag dropdown and on each image's tag list, and can be filtered like any other tag. The **+** turns into a **✓**; click that to remove the tag again from every image.

This is deliberately one phrase at a time. Auto-promoting everything would mean **46,977 tags across 6.7 million rows** on a library this size — the tag dropdown would become unusable and the handful of tags you chose by hand would be lost in it. Tags are worth most for what the prompt *cannot* tell you (which person, which shoot, which keeper); the phrase panel already covers what the prompt does say.

Promoted tags are **not renamed or prefixed**. A tag is a tag — `regency era` searches, filters and displays exactly like `ballroom`. imgmgr only records where each tag row came from, in a `source` column, so that:

- removing a promoted tag takes out the whole batch in one click, and
- if you had already made a tag by hand with the same name, **your version survives** that removal.

> Promoting a common phrase can write tens of thousands of rows in one click (`blurred background` = 14,671 images). It is instant and fully undoable, but it is a real change to your library, not a filter — so above **500 images** imgmgr asks you to confirm first. Smaller promotions go through immediately.

**How phrases are found.** Prompts come in two dialects, often in the same library: tag lists (`1woman, blonde hair, forest`) and prose (`…a woman with long red hair in a messy high ponytail…`). Both are cut on commas first, since grammar commas chunk prose much as tag commas chunk a tag list. A short chunk is kept whole, because it is already a concept. A long one is split at function words — `a`, `with`, `in` — into runs of content words, and each run contributes itself plus its endings:

```text
"a woman with long red hair in a messy high ponytail"
  -> woman | long red hair | red hair | hair | messy high ponytail | high ponytail | ponytail
```

Endings and not every fragment, because in English the noun comes last: `red hair` is a concept, `long red` is not. No grammar rules and no language library are involved beyond that — **frequency decides.** A real concept recurs thousands of times across the library; an accidental word pair does not, and a phrase seen fewer than three times is dropped. Finally, a phrase that is only a fragment of an equally common longer one is hidden: if `regency era` appears 32,735 times and `era` 33,003, you see just `regency era`.

The counts are a **floor, not an exact figure** — clicking a phrase can return somewhat more images than the number shown, because the search also matches the phrase inside longer ones. It will not return fewer.

> Building the index takes about **4 seconds per 100,000 prompts** and happens automatically a few seconds after the server starts, but only the first time (or after an upgrade changes how phrases are cut).

### Find similar images

Open any image in the lightbox and click **🔍 Similar** in the top bar. imgmgr compares the image's perceptual hash against the whole library and shows every visually similar image, nearest first. A banner indicates you're in similar-search mode — click **← Back to all images** to return.

The hash is a **DCT-based pHash** (a 2-D discrete cosine transform of the image, thresholded against its median) that keys on overall composition rather than fine pixel detail — well suited to spotting different seeds of the same prompt. The banner also has a **Strict ↔ Loose** slider that adjusts the match threshold: drag toward *Strict* for near-identical images only, or toward *Loose* to include looser compositional matches. Your setting is remembered across sessions.

### AI captions

imgmgr can generate a natural-language caption for an image by sending it to an [SDNext](https://github.com/vladmandic/sdnext) server's vision endpoint (`/sdapi/v1/vqa`). Point `sdnextUrl` at your running SDNext instance and pick a `captionModel` in `config.json` (see the [config table](#setup)); the model must be available on that server.

- **Single image** — open the lightbox and expand the **Caption** section in the sidebar, then click **✦ Generate caption**. The result is saved and shown there (collapsible, with its own **Copy** button); use **↻ Regenerate caption** to replace it.
- **Many images** — select images in the grid and click **✦ Caption N** in the toolbar. They're captioned one at a time with a live `Captioning 3/12…` progress indicator; each caption is stored as it completes.

Captions are stored in the database and can be searched with the `caption:` prefix in the search bar (see [Search syntax](#search-syntax)) — for example `caption:"stone bridge"`.

> **Note:** captioning is a heavy operation on the SDNext side. The first request after the model loads can take a minute or so; subsequent ones are faster. imgmgr downscales each image before sending it to keep the request small.

### Rating images

Click the stars in the lightbox sidebar, hover a tile and use the star overlay directly on the grid, or press the `0`–`5` keys (or `F` for 5★) while viewing an image. To rate many at once, select images and use the **Rate:** star control in the toolbar (the **0★** button clears the rating on the selection).

### Multi-select and bulk actions

- Click the **checkbox button** in the top-left corner of a tile to select it (or click again to deselect).
- Use **All** / **None** in the toolbar to select or clear the whole page.
- With images selected, **Rate:** sets a star rating on all of them, **Move N →** opens a folder picker, **Tag N →** adds/removes a tag, **✦ Caption N** generates captions for the whole selection (see [AI captions](#ai-captions)), and **Delete N** moves them to the trash.

> **Starred images are protected from deletion.** Any image with a rating of 1★ or higher is refused by the delete routes — in bulk delete, the lightbox `Del` shortcut, and the duplicate finder alike. You'll see a notice reporting how many were skipped; remove the stars first if you really want to delete them.

### Trash & undo

Deletes are **recoverable**. Instead of erasing files, imgmgr moves them into a trash folder (under `cacheDir`, so it works even when the image root is read-only) and hides them from all views.

- Right after deleting, an **Undo** toast appears — click it to put the images straight back.
- Click **🗑 Trash** in the header to browse deleted images. There you can **Restore** selected images to their original folders, **Delete permanently** (removes them from disk for good), or **Empty trash**.
- The duplicate finder also deletes to the trash, so its removals are recoverable too.

### Moving images

Drag a tile and drop it onto a folder in the tree, or use the **Move N →** button in the toolbar after selecting images. This renames the file on disk and updates its database row in place, so ratings, tags, captions and metadata all follow it.

#### Reorganising folders outside imgmgr

You can also move or rename folders directly on disk (with `mv`, a file manager, etc.). Thumbnails are cached by **content hash** (`.cache/thumbs/<md5>.webp`), so they're reused no matter where a file ends up — nothing is regenerated.

The database, however, identifies an image by its **path**. To stop an external move from looking like "one file deleted, one unrelated file added" — which would drop the old row and its star rating, tags and caption — the scanner reconciles moves before it indexes or prunes: any file that vanished is matched by content hash against the newly-appeared files, and on a match the existing row is simply repointed at the new path. Same row, so **ratings, tags, captions and metadata survive** a folder move or rename.

Just run a scan afterwards (restart the server, or `POST /api/scan`) so the new locations are picked up; the console reports how many files were relocated. Until then the moved images show broken thumbnails, since their stored paths are stale.

> Matching is by file content, so renamed files are recognised too. When several byte-identical copies move at once, imgmgr pairs them up deterministically — which copy inherits which row is arbitrary, but the content is the same either way. Scans where nothing has moved skip this step entirely, so there's no added cost.

### Offline media (removable drives, network shares)

Images that live on an external drive or an NFS/SMB share don't have to be connected for you to use imgmgr. When a scan finds a file gone, its entry is **flagged as offline, never deleted**:

- The image **stays in the grid** and keeps its cached thumbnail, so you can browse, search, filter, rate and tag it exactly as before. It's dimmed and badged **⚠ offline**.
- **Ratings, tags, captions and metadata are all preserved.** Opening one in the lightbox shows the cached thumbnail with a note explaining the original isn't reachable and when it went missing.
- A toolbar banner reports how many files are offline, with **Show offline only** to review them.
- **Reconnect the drive and re-scan** and the flag clears itself automatically — everything is exactly as you left it. If the files come back at a *different* path, the content-hash matching above repoints them, so a move while disconnected is fine too.

Nothing is ever removed automatically. If you genuinely want to forget images whose files are gone for good, click **Delete orphaned data** in that banner — it asks for confirmation, then drops those database entries and their cached thumbnails. That's the only thing that removes a vanished image.

> This also means a share that fails to mount can't cost you anything: worst case every image is flagged offline until it's reachable again.

### Duplicate finder

Click **Duplicates** in the toolbar to open the duplicate panel.

| Mode | How it works |
|------|-------------|
| **Exact** | Groups images with identical MD5 file hashes |
| **Seed** | Groups images sharing the same generation seed (last number in the filename, e.g. `00042-1827738702.png`) |

> A third **Visual** mode (perceptual-hash grouping) was removed. It compared every image against every other one, which meant hours of a frozen server on a large library — and the groupings weren't good. Use **🔍 Similar** in the lightbox instead: it compares one image against the library and returns instantly.

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
│   ├── migrate.js        # One-time backfills (gen-param facets, pHash recompute)
│   ├── scanner.js        # Full directory scan + file indexing
│   ├── meta.js           # PNG tEXt / WebP+JPEG EXIF + gen-param extraction
│   ├── thumbnails.js     # Sharp thumbnail generation, DCT pHash, file hash
│   ├── caption.js        # AI captioning via the SDNext VQA endpoint
│   ├── duplicates.js     # Exact / seed duplicate detection
│   ├── phrases.js        # Mines recurring phrases out of prompts
│   ├── trash.js          # Soft-delete: trash / restore / purge
│   ├── watcher.js        # Chokidar file watcher (today's folder only)
│   ├── events.js         # SSE broadcast utility
│   └── routes/
│       ├── images.js     # Image list/filter, ratings, tags, trash, facets, similar, caption
│       ├── folders.js    # Folder listing and creation
│       ├── duplicates.js # Duplicate find and delete endpoints
│       ├── phrases.js    # Top-phrase list and index rebuild
│       └── tags.js       # Global tag listing and bulk add/remove
├── client/
│   ├── src/
│   │   ├── App.jsx       # Root component, state, SSE hook
│   │   ├── api.js        # fetch wrappers for all API endpoints
│   │   ├── usePersistentState.js  # localStorage-backed useState hook
│   │   └── components/
│   │       ├── Toolbar.jsx
│   │       ├── FolderTree.jsx
│   │       ├── PhrasePanel.jsx
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
