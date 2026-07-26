import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { api } from './api.js';
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
  const lastClickedId = useRef(null);

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

  // Fetch a page. off === 0 resets the list (filter change); otherwise appends.
  const fetchPage = useCallback(async (off = 0) => {
    if (off !== 0 && loadingRef.current) return; // only block concurrent appends
    const myReq = ++reqIdRef.current;
    loadingRef.current = true;
    try {
      let data;
      if (similarTo) {
        data = await api.similar(similarTo); // returns the whole match set, unpaginated
      } else {
        const params = trashView
          ? { trashed: 1, limit: PAGE, offset: off }
          : {
              folder: currentFolder, sort, favorite_min: favoriteMin, search, tag: tagFilter,
              facets: JSON.stringify(facets), limit: PAGE, offset: off,
            };
        data = await api.images(params);
      }
      if (myReq !== reqIdRef.current) return; // a newer load superseded this one
      offsetRef.current = (similarTo ? 0 : off) + data.images.length;
      if (off === 0 || similarTo) {
        setImages(data.images);
      } else {
        setImages(prev => [...prev, ...data.images]);
      }
      setTotal(data.total);
    } finally {
      if (myReq === reqIdRef.current) loadingRef.current = false;
    }
  }, [currentFolder, sort, favoriteMin, search, tagFilter, trashView, facets, similarTo]);

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
          <span className="app-title">imgmgr</span>
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
          <aside className="sidebar">
            <FolderTree
              currentFolder={currentFolder}
              onNavigate={f => { setCurrentFolder(f); setSelectedIds(new Set()); }}
            />
          </aside>

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
                onBulkRate={handleBulkRate}
                onSelectAll={async () => {
                  const ids = await api.imageIds({
                    folder: currentFolder,
                    favorite_min: favoriteMin,
                    search,
                    tag: tagFilter,
                    facets: JSON.stringify(facets),
                  });
                  setSelectedIds(new Set(ids));
                }}
                onDeselectAll={() => setSelectedIds(new Set())}
                onMoveSelected={() => {/* prompt handled in toolbar */}}
                onDeleteSelected={() => handleDelete([...selectedIds])}
                currentFolder={currentFolder}
                onMoveToFolder={(folder) => handleMove([...selectedIds], folder)}
                onBulkTag={handleBulkTag}
                hasNewImages={hasNewImages}
                onRefreshNew={() => { setHasNewImages(false); fetchPage(0); }}
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
            />
          </main>
        </div>
      </div>

      {viewerId != null && (
        <ImageViewer
          imageId={viewerId}
          imageIds={viewerImages}
          onClose={() => setViewerId(null)}
          onNavigate={setViewerId}
          onFavoriteChange={handleFavoriteChange}
          onDelete={handleViewerDelete}
          onLoadMore={loadMore}
          hasMore={images.length < total}
          total={total}
          onFindSimilar={showSimilar}
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
