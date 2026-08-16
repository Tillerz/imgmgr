import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { api } from './api.js';
import usePersistentState from './usePersistentState.js';
import FolderTree from './components/FolderTree.jsx';
import Toolbar from './components/Toolbar.jsx';
import TileGrid from './components/TileGrid.jsx';
import ImageViewer from './components/ImageViewer.jsx';
import DuplicatePanel from './components/DuplicatePanel.jsx';

export default function App() {
  const qc = useQueryClient();
  const [currentFolder, setCurrentFolder] = useState('');
  const [sort, setSort] = useState('mtime-desc');
  const [favoriteMin, setFavoriteMin] = useState(0);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [viewerId, setViewerId] = useState(null);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [hasNewImages, setHasNewImages] = useState(false);
  const [trashView, setTrashView] = useState(false);
  const [undo, setUndo] = useState(null); // { ids, count } — last soft-deleted batch
  const [facets, setFacets] = useState({}); // { Model: '…', Sampler: '…' }
  const [similarTo, setSimilarTo] = useState(null); // image id we're showing matches for
  const [similarThreshold, setSimilarThreshold] = usePersistentState('imgmgr.similarThreshold', 14); // max hash distance for "similar"
  const [captioning, setCaptioning] = useState(null); // { done, total } while bulk-captioning
  const [missingFilter, setMissingFilter] = useState(''); // '' = all, '1' = only offline files
  const [captionFilter, setCaptionFilter] = useState(''); // '' = all, '1' = captioned, '0' = not
  const [favoriteExact, setFavoriteExact] = usePersistentState('imgmgr.favoriteExact', false);
  const [sidebarOpen, setSidebarOpen] = usePersistentState('imgmgr.sidebarOpen', true);
  // Slideshow. `scope`/`speed` are remembered; `slideshowIds` is the full id list
  // being played and doubles as the running flag (null = stopped). The list is
  // fetched complete up front so playback can wrap from the last image to the
  // first without waiting on pagination.
  const [slideScope, setSlideScope] = usePersistentState('imgmgr.slideScope', 'folder');
  const [slideSpeed, setSlideSpeed] = usePersistentState('imgmgr.slideSpeed', 5);
  const [slideshowIds, setSlideshowIds] = useState(null);
  const [slidePaused, setSlidePaused] = useState(false);
  const lastClickedId = useRef(null);

  // `B` toggles the folder sidebar. Ignored while typing, and while the lightbox
  // is open (it has its own shortcuts and its own panel toggle).
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'b' && e.key !== 'B') return;
      if (viewerId != null) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      setSidebarOpen(v => !v);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewerId, setSidebarOpen]);

  // SSE: listen for server-pushed change notifications
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('images:changed', () => setHasNewImages(true));
    es.onerror = () => {}; // reconnects automatically
    return () => es.close();
  }, []);

  // All loaded images for current view (accumulated pages)
  const [images, setImages] = useState([]);
  const [total, setTotal] = useState(0);
  const PAGE = 100;

  // Next page offset, advanced synchronously so a burst of scroll events can't
  // re-request the same page before React commits the new state (which caused
  // duplicate pages to be appended).
  const offsetRef = useRef(0);
  const loadingRef = useRef(false);   // blocks concurrent appends
  const reqIdRef = useRef(0);         // supersedes in-flight loads when filters change
  // Max image id at the time this result set started. Echoed back on every
  // follow-up page so images indexed while scrolling can't shift the offsets
  // (see the snapshot comment in server/routes/images.js). Reset on each
  // fresh load; the "New images available" banner picks up a new snapshot.
  const snapshotRef = useRef(null);

  // Fetch a page. off === 0 resets the list (filter change); otherwise appends.
  const fetchPage = useCallback(async (off = 0) => {
    if (off !== 0 && loadingRef.current) return; // only block concurrent appends
    const myReq = ++reqIdRef.current;
    loadingRef.current = true;
    try {
      let data;
      if (similarTo) {
        data = await api.similar(similarTo, similarThreshold); // returns the whole match set, unpaginated
      } else {
        if (off === 0) snapshotRef.current = null; // fresh listing → new snapshot
        const params = trashView
          ? { trashed: 1, limit: PAGE, offset: off }
          : {
              folder: currentFolder, sort, search, tag: tagFilter,
              facets: JSON.stringify(facets), limit: PAGE, offset: off,
              // Exact mode pins one rating; otherwise it's "this many stars and up".
              ...(favoriteExact ? { favorite_eq: favoriteMin } : { favorite_min: favoriteMin }),
              ...(missingFilter ? { missing: missingFilter } : {}),
              ...(captionFilter ? { caption: captionFilter } : {}),
            };
        if (snapshotRef.current != null) params.max_id = snapshotRef.current;
        data = await api.images(params);
      }
      if (myReq !== reqIdRef.current) return; // a newer load superseded this one
      if (data.snapshot != null) snapshotRef.current = data.snapshot;
      offsetRef.current = (similarTo ? 0 : off) + data.images.length;
      if (off === 0 || similarTo) {
        setImages(data.images);
      } else {
        // Drop ids we already hold. The snapshot should prevent overlap, but a
        // soft-delete elsewhere can still shift the window mid-scroll, and
        // duplicate ids would collide as React keys and render repeated rows.
        setImages(prev => {
          const seen = new Set(prev.map(i => i.id));
          const fresh = data.images.filter(i => !seen.has(i.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      }
      setTotal(data.total);
    } finally {
      if (myReq === reqIdRef.current) loadingRef.current = false;
    }
  }, [currentFolder, sort, favoriteMin, favoriteExact, search, tagFilter, trashView, facets, similarTo, similarThreshold, missingFilter, captionFilter]);

  // Initial load and on filter change
  React.useEffect(() => {
    setSelectedIds(new Set());
    offsetRef.current = 0;
    fetchPage(0);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!loadingRef.current && offsetRef.current < total) fetchPage(offsetRef.current);
  }, [total, fetchPage]);

  const handleSelect = useCallback((id, mode, sortedIds) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (mode === 'toggle') {
        if (next.has(id)) next.delete(id); else next.add(id);
        lastClickedId.current = id;
      } else if (mode === 'range' && lastClickedId.current != null && sortedIds) {
        const a = sortedIds.indexOf(lastClickedId.current);
        const b = sortedIds.indexOf(id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) next.add(sortedIds[i]);
      } else {
        // single click without modifier: just open (handled in TileGrid)
        lastClickedId.current = id;
      }
      return next;
    });
  }, []);

  const handleOpen = useCallback((id) => {
    setViewerId(id);
  }, []);

  const handleFavoriteChange = useCallback(async (id, level) => {
    await api.setFavorite(id, level);
    setImages(prev => prev.map(img => img.id === id ? { ...img, favorite: level } : img));
    qc.setQueryData(['image', id], prev => prev ? { ...prev, favorite: level } : prev);
  }, [qc]);

  const handleBulkRate = useCallback(async (level) => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    await api.bulkFavorite(ids, level);
    const idSet = new Set(ids);
    setImages(prev => prev.map(img => idSet.has(img.id) ? { ...img, favorite: level } : img));
    ids.forEach(id => qc.setQueryData(['image', id], prev => prev ? { ...prev, favorite: level } : prev));
  }, [selectedIds, qc]);

  // Caption the selected images. VQA is heavy, so run one at a time client-side
  // with live progress; each result is cached so open viewers update immediately.
  const handleCaptionSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (!ids.length || captioning) return;
    setCaptioning({ done: 0, total: ids.length });
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        const r = await api.caption(ids[i]);
        qc.setQueryData(['image', ids[i]], prev => (prev ? { ...prev, caption: r.caption } : prev));
      } catch { failed++; }
      setCaptioning({ done: i + 1, total: ids.length });
    }
    setCaptioning(null);
    if (failed) alert(`Captioning finished with ${failed} error(s) out of ${ids.length}.`);
  }, [selectedIds, captioning, qc]);

  // Forget every offline image: drops the database rows and cached thumbnails.
  // Destructive and irreversible, so it's always an explicit, confirmed action —
  // a share that simply failed to mount must never lose data silently.
  const handlePurgeMissing = useCallback(async () => {
    const { missing } = await api.missingCount();
    if (!missing) return;
    const ok = window.confirm(
      `Permanently forget ${missing} offline image${missing === 1 ? '' : 's'}?\n\n` +
      'Their ratings, tags, captions and cached thumbnails will be deleted.\n' +
      'The image files themselves are already gone — nothing else is touched.\n\n' +
      "If this is just a disconnected drive or share, cancel and reconnect it instead."
    );
    if (!ok) return;
    const r = await api.purgeMissing();
    setMissingFilter('');
    qc.invalidateQueries({ queryKey: ['missingCount'] });
    qc.invalidateQueries({ queryKey: ['favCounts'] });
    offsetRef.current = 0;
    fetchPage(0);
    alert(`Removed ${r.purged} entr${r.purged === 1 ? 'y' : 'ies'} and ${r.thumbnails} cached thumbnail(s).`);
  }, [qc, fetchPage]);

  // The active filters, in the shape /api/images/ids expects. Used by both
  // "select all" and the slideshow so they always match what the grid shows.
  const currentFilterParams = useCallback(() => ({
    folder: currentFolder, search, tag: tagFilter, facets: JSON.stringify(facets),
    ...(favoriteExact ? { favorite_eq: favoriteMin } : { favorite_min: favoriteMin }),
    ...(missingFilter ? { missing: missingFilter } : {}),
    ...(captionFilter ? { caption: captionFilter } : {}),
  }), [currentFolder, search, tagFilter, facets, favoriteExact, favoriteMin, missingFilter, captionFilter]);

  // Start the slideshow.
  //   'all'      — the whole library, ignoring every filter
  //   'folder'   — exactly what the grid is showing
  //   'selected' — only the ticked images, in grid order
  // Playback begins at the open image, else the first selected tile, else the
  // first image in the list.
  const startSlideshow = useCallback(async () => {
    let ids;
    if (slideScope === 'selected') {
      if (!selectedIds.size) { window.alert('No images are selected.'); return; }
      // Prefer grid order; selections made via "All" can include unloaded rows,
      // so anything not on screen is appended afterwards.
      const onScreen = images.map(i => i.id).filter(id => selectedIds.has(id));
      const rest = [...selectedIds].filter(id => !onScreen.includes(id));
      ids = [...onScreen, ...rest];
    } else {
      ids = await api.imageIds(slideScope === 'all' ? {} : currentFilterParams());
    }
    if (!ids.length) { window.alert('Nothing to show here.'); return; }
    const preferred = viewerId ?? [...selectedIds][0];
    setSlideshowIds(ids);
    setSlidePaused(false);
    setViewerId(ids.includes(preferred) ? preferred : ids[0]);
  }, [slideScope, selectedIds, images, currentFilterParams, viewerId]);

  const stopSlideshow = useCallback(() => {
    setSlideshowIds(null);
    setSlidePaused(false);
  }, []);

  // Advance on a timer, wrapping past the last image back to the first.
  useEffect(() => {
    if (!slideshowIds?.length || slidePaused) return;
    const t = setInterval(() => {
      setViewerId(cur => {
        const i = slideshowIds.indexOf(cur);
        return slideshowIds[(i + 1) % slideshowIds.length]; // -1 + 1 = 0 → first
      });
    }, Math.max(1, slideSpeed) * 1000);
    return () => clearInterval(t);
  }, [slideshowIds, slideSpeed, slidePaused]);

  // Show images visually similar to the given one (from the lightbox).
  const showSimilar = useCallback((id) => {
    setTrashView(false);
    setSelectedIds(new Set());
    setViewerId(null);
    setSimilarTo(id);
  }, []);

  const handleMove = useCallback(async (ids, targetFolder) => {
    await api.move(ids, targetFolder);
    setImages(prev => prev.filter(img => !ids.includes(img.id)));
    setSelectedIds(new Set());
    qc.invalidateQueries(['folders']);
  }, [qc]);

  const handleDelete = useCallback(async (ids) => {
    // Soft delete → trash; no confirm needed since it's recoverable via Undo/Trash.
    const res = await api.delete(ids);
    const trashed = res?.trashed || [];
    setImages(prev => prev.filter(img => !trashed.includes(img.id)));
    setSelectedIds(new Set());
    if (trashed.length) setUndo({ ids: trashed, count: trashed.length });
    if (res?.skipped?.length) {
      window.alert(`${res.skipped.length} starred image(s) were protected and not moved to trash.`);
    }
  }, []);

  // Delete the image open in the viewer, then advance to the next one (or the
  // previous if it was the last; close the viewer if it was the only image).
  // Starred images are protected: the server refuses them, so we stay put.
  const handleViewerDelete = useCallback(async (id) => {
    const idx = images.findIndex(img => img.id === id);
    if (idx === -1) return;
    const nextImg = images[idx + 1] || images[idx - 1] || null;
    const res = await api.delete([id]);
    if (!res?.trashed?.includes(id)) return; // protected/failed — leave the viewer as-is
    setImages(prev => prev.filter(img => img.id !== id));
    setSelectedIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setUndo({ ids: [id], count: 1 });
    setViewerId(nextImg ? nextImg.id : null);
  }, [images]);

  // Restore images from the trash. In the trash view they leave the list; the
  // Undo toast uses this too (followed by a refresh to bring them back).
  const handleRestore = useCallback(async (ids) => {
    if (!ids.length) return;
    await api.restore(ids);
    setImages(prev => prev.filter(img => !ids.includes(img.id)));
    setSelectedIds(new Set());
    qc.invalidateQueries(['folders']);
  }, [qc]);

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    await api.restore(undo.ids);
    setUndo(null);
    fetchPage(0); // bring the restored images back into the current view
    qc.invalidateQueries(['folders']);
  }, [undo, fetchPage, qc]);

  const handlePurge = useCallback(async (ids) => {
    if (!ids.length) return;
    if (!window.confirm(`Permanently delete ${ids.length} image(s) from disk? This cannot be undone.`)) return;
    await api.purgeTrash(ids);
    setImages(prev => prev.filter(img => !ids.includes(img.id)));
    setSelectedIds(new Set());
  }, []);

  const handleEmptyTrash = useCallback(async () => {
    if (!window.confirm('Permanently delete ALL images in the trash? This cannot be undone.')) return;
    await api.purgeTrash([]);
    setSelectedIds(new Set());
    fetchPage(0);
  }, [fetchPage]);

  const handleBulkTag = useCallback(async (tag, action) => {
    if (!tag.trim()) return;
    if (action === 'add') {
      await api.bulkAddTag([...selectedIds], tag);
    } else {
      await api.bulkRemoveTag([...selectedIds], tag);
    }
    qc.invalidateQueries({ queryKey: ['allTags'] });
  }, [selectedIds, qc]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    await api.scan();
    // Poll until done
    const poll = setInterval(async () => {
      const { running } = await api.scanStatus();
      if (!running) {
        clearInterval(poll);
        setScanning(false);
        fetchPage(0);
        qc.invalidateQueries(['folders']);
      }
    }, 1500);
  }, [fetchPage, qc]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = useCallback(({ active, over }) => {
    if (!over) return;
    if (over.data?.current?.type !== 'folder') return;
    const targetFolder = over.data.current.path;
    const ids = selectedIds.has(active.id)
      ? [...selectedIds]
      : [active.id];
    handleMove(ids, targetFolder);
  }, [selectedIds, handleMove]);

  const viewerImages = images.map(i => i.id);

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="app-layout">
        <header className="app-header">
          <span className="app-title">ImgMgr by Tillerz</span>
          <button
            className={`btn btn-secondary ${scanning ? 'scanning' : ''}`}
            onClick={handleScan}
            disabled={scanning}
          >
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
          <button className="btn btn-secondary" onClick={() => setShowDuplicates(true)}>
            Duplicates
          </button>
          <button
            className={`btn btn-secondary ${trashView ? 'active' : ''}`}
            onClick={() => { setSimilarTo(null); setTrashView(v => !v); setSelectedIds(new Set()); }}
          >
            {trashView ? '← Back to images' : '🗑 Trash'}
          </button>
        </header>

        <div className="app-body">
          {sidebarOpen ? (
            <aside className="sidebar">
              <button
                className="sidebar-toggle"
                onClick={() => setSidebarOpen(false)}
                title="Hide the folder list (B)"
              >
                ‹ Hide
              </button>
              <FolderTree
                currentFolder={currentFolder}
                onNavigate={f => { setCurrentFolder(f); setSelectedIds(new Set()); }}
              />
            </aside>
          ) : (
            <button
              className="sidebar-reopen"
              onClick={() => setSidebarOpen(true)}
              title="Show the folder list (B)"
            >
              ›
            </button>
          )}

          <main className="main-content">
            {trashView ? (
              <div className="toolbar">
                <div className="toolbar-row toolbar-actions">
                  <span className="count-label">
                    🗑 Trash · {images.length} / {total}
                    {selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
                  </span>
                  <button className="btn btn-secondary btn-sm" onClick={() => setSelectedIds(new Set(images.map(i => i.id)))}>All</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setSelectedIds(new Set())}>None</button>
                  {selectedIds.size > 0 && (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={() => handleRestore([...selectedIds])}>
                        Restore {selectedIds.size}
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => handlePurge([...selectedIds])}>
                        Delete {selectedIds.size} permanently
                      </button>
                    </>
                  )}
                  {total > 0 && (
                    <button className="btn btn-danger btn-sm" onClick={handleEmptyTrash}>Empty trash</button>
                  )}
                </div>
              </div>
            ) : similarTo ? (
              <div className="toolbar">
                <div className="toolbar-row toolbar-actions">
                  <span className="count-label">🔍 Visually similar images · {images.length} found</span>
                  <label
                    className="similar-threshold"
                    title="How alike a match must be. Lower = stricter (only near-identical images); higher = looser (more matches, but less similar)."
                  >
                    <span>Strict</span>
                    <input
                      type="range" min="4" max="24" step="1"
                      value={similarThreshold}
                      onChange={e => setSimilarThreshold(Number(e.target.value))}
                    />
                    <span>Loose</span>
                    <span className="similar-threshold-val">{similarThreshold}</span>
                  </label>
                  <button className="btn btn-secondary btn-sm" onClick={() => setSimilarTo(null)}>← Back to all images</button>
                </div>
              </div>
            ) : (
              <Toolbar
                sort={sort} onSort={setSort}
                favoriteMin={favoriteMin} onFavoriteMin={setFavoriteMin}
                search={search} onSearch={setSearch}
                tagFilter={tagFilter} onTagFilter={setTagFilter}
                facets={facets} onFacet={(key, value) => setFacets(prev => {
                  const next = { ...prev };
                  if (value) next[key] = value; else delete next[key];
                  return next;
                })}
                selectedCount={selectedIds.size}
                total={total}
                loaded={images.length}
                missingFilter={missingFilter}
                onMissingFilter={setMissingFilter}
                onPurgeMissing={handlePurgeMissing}
                captionFilter={captionFilter}
                onCaptionFilter={setCaptionFilter}
                favoriteExact={favoriteExact}
                onFavoriteExact={setFavoriteExact}
                onBulkRate={handleBulkRate}
                onCaptionSelected={handleCaptionSelected}
                captioning={captioning}
                onSelectAll={async () => {
                  setSelectedIds(new Set(await api.imageIds(currentFilterParams())));
                }}
                onDeselectAll={() => setSelectedIds(new Set())}
                onMoveSelected={() => {/* prompt handled in toolbar */}}
                onDeleteSelected={() => handleDelete([...selectedIds])}
                currentFolder={currentFolder}
                onMoveToFolder={(folder) => handleMove([...selectedIds], folder)}
                onBulkTag={handleBulkTag}
                hasNewImages={hasNewImages}
                onRefreshNew={() => { setHasNewImages(false); fetchPage(0); }}
                slideScope={slideScope}
                onSlideScope={setSlideScope}
                slideSpeed={slideSpeed}
                onSlideSpeed={setSlideSpeed}
                slideshowRunning={!!slideshowIds}
                onStartSlideshow={startSlideshow}
                onStopSlideshow={stopSlideshow}
              />
            )}
            <TileGrid
              images={images}
              selectedIds={selectedIds}
              onSelect={handleSelect}
              onOpen={trashView ? (id) => handleSelect(id, 'toggle', images.map(i => i.id)) : handleOpen}
              onFavoriteChange={handleFavoriteChange}
              onLoadMore={loadMore}
              hasMore={images.length < total}
              viewKey={JSON.stringify([
                currentFolder, sort, favoriteMin, favoriteExact, search, tagFilter,
                facets, trashView, similarTo, missingFilter, captionFilter,
              ])}
            />
          </main>
        </div>
      </div>

      {viewerId != null && (
        <ImageViewer
          imageId={viewerId}
          // While playing, navigate the complete slideshow list rather than the
          // paginated grid, so the counter and wrap-around are correct.
          imageIds={slideshowIds || viewerImages}
          onClose={() => { stopSlideshow(); setViewerId(null); }}
          onNavigate={setViewerId}
          onFavoriteChange={handleFavoriteChange}
          onDelete={handleViewerDelete}
          onLoadMore={slideshowIds ? undefined : loadMore}
          hasMore={slideshowIds ? false : images.length < total}
          total={slideshowIds ? slideshowIds.length : total}
          onFindSimilar={showSimilar}
          slideshowRunning={!!slideshowIds}
          slidePaused={slidePaused}
          onTogglePause={() => setSlidePaused(p => !p)}
          onStopSlideshow={stopSlideshow}
        />
      )}

      {showDuplicates && (
        <DuplicatePanel
          onClose={() => setShowDuplicates(false)}
          onDeleted={() => fetchPage(0)}
        />
      )}

      {undo && !trashView && (
        <div className="undo-toast">
          <span>Moved {undo.count} image{undo.count > 1 ? 's' : ''} to trash</span>
          <button className="undo-btn" onClick={handleUndo}>Undo</button>
          <button className="undo-dismiss" onClick={() => setUndo(null)} title="Dismiss">✕</button>
        </div>
      )}
    </DndContext>
  );
}
