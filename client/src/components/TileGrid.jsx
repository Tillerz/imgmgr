import React, { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { api } from '../api.js';
import StarRating from './StarRating.jsx';

// These mirror style.css (.tile-grid-wrap padding, .tile-grid gap, --tile-min-width).
const PAD = 12;
const GAP = 10;
const TILE_MIN = 200;
const OVERSCAN = 3; // rows rendered above/below the viewport

function Tile({ image, selected, onSelect, onOpen, onFavoriteChange, sortedIds, innerRef }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: image.id,
    data: { type: 'image', id: image.id },
  });

  // Compose the dnd ref with the optional measuring ref.
  const setRefs = useCallback((node) => {
    setNodeRef(node);
    if (innerRef) innerRef(node);
  }, [setNodeRef, innerRef]);

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 1000, opacity: 0.85 }
    : undefined;

  const handleClick = useCallback((e) => {
    if (isDragging) return;
    if (e.ctrlKey || e.metaKey) {
      onSelect(image.id, 'toggle', sortedIds);
    } else if (e.shiftKey) {
      onSelect(image.id, 'range', sortedIds);
    } else {
      onOpen(image.id);
    }
  }, [isDragging, image.id, onSelect, onOpen, sortedIds]);

  const handleSelectClick = useCallback((e) => {
    e.stopPropagation();
    onSelect(image.id, 'toggle', sortedIds);
  }, [image.id, onSelect, sortedIds]);

  const [copied, setCopied] = useState(false);
  const handleCopyPrompt = useCallback((e) => {
    e.stopPropagation();
    if (!image.positive_prompt) return;
    navigator.clipboard.writeText(image.positive_prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [image.positive_prompt]);

  const date = image.mtime ? new Date(image.mtime).toLocaleDateString() : '';

  return (
    <div
      ref={setRefs}
      style={style}
      className={`tile ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${image.missing_at ? 'missing' : ''}`}
      onClick={handleClick}
      {...attributes}
      {...listeners}
    >
      <div className="tile-img-wrap">
        <img
          src={api.thumb(image.id)}
          alt={image.filename}
          loading="lazy"
          draggable={false}
        />
        {selected && <div className="tile-check-overlay">✓</div>}
        {image.missing_at && (
          <div
            className="tile-missing-badge"
            title={`File offline since ${new Date(image.missing_at).toLocaleString()}\n${image.path || ''}\nThumbnail and details are still cached.`}
          >
            ⚠ offline
          </div>
        )}
        <div className="tile-select-btn" onClick={handleSelectClick} title="Select">◻</div>
        {image.positive_prompt && (
          <div
            className={`tile-copy-btn ${copied ? 'copied' : ''}`}
            onClick={handleCopyPrompt}
            title="Copy prompt"
          >
            {copied ? '✓' : '⧉'}
          </div>
        )}
      </div>
      <div className="tile-info">
        <span className="tile-filename" title={image.filename}>{image.filename}</span>
        <div className="tile-meta-row">
          <span className="tile-date">{date}</span>
          <StarRating value={image.favorite} onChange={v => onFavoriteChange(image.id, v)} size="xs" />
        </div>
      </div>
    </div>
  );
}

export default function TileGrid({ images, selectedIds, onSelect, onOpen, onFavoriteChange, onLoadMore, hasMore, viewKey = '' }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [tileH, setTileH] = useState(260); // measured from a real tile
  const sortedIds = images.map(i => i.id);

  // Track the scroll container's size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Scroll position memory -------------------------------------------
  // Remembered per view (`viewKey` encodes the active filters), so reopening the
  // app — or coming back from the trash — lands where you left off instead of at
  // the top of 98k images. Changing filters is a different view and starts fresh.
  const SCROLL_KEY = 'imgmgr.gridScroll';
  const readSaved = () => {
    try { return JSON.parse(localStorage.getItem(SCROLL_KEY) || 'null'); } catch { return null; }
  };
  const restoredRef = useRef(false);   // done (or given up) for this view
  const attemptsRef = useRef(0);       // pages pulled in while seeking back

  // A new view: reset, unless we have a saved position for exactly this one.
  useEffect(() => {
    restoredRef.current = false;
    attemptsRef.current = 0;
    const saved = readSaved();
    if (!saved || saved.key !== viewKey || !saved.top) {
      if (wrapRef.current) wrapRef.current.scrollTop = 0;
      setScrollTop(0);
      restoredRef.current = true;
    }
  }, [viewKey]);

  // Seek back to the saved offset. A deep position needs more pages than the
  // first fetch returns, so scroll as far as we can, pull the next page, and
  // retry — bounded, so a stale offset can't spin through the whole library.
  useEffect(() => {
    if (restoredRef.current) return;
    const el = wrapRef.current;
    if (!el || !images.length) return;
    const saved = readSaved();
    if (!saved || saved.key !== viewKey) { restoredRef.current = true; return; }

    const max = el.scrollHeight - el.clientHeight;
    if (saved.top <= max) {
      el.scrollTop = saved.top;
      setScrollTop(saved.top);
      restoredRef.current = true;
    } else if (hasMore && attemptsRef.current < 40) {
      attemptsRef.current++;
      el.scrollTop = max;
      setScrollTop(max);
      onLoadMore?.();
    } else {
      restoredRef.current = true; // as close as we can get
    }
  }, [viewKey, images.length, size.height, hasMore, onLoadMore]);

  // Persist the position once restoring is finished (debounced).
  useEffect(() => {
    if (!restoredRef.current || !viewKey) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(SCROLL_KEY, JSON.stringify({ key: viewKey, top: Math.round(scrollTop) })); } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [scrollTop, viewKey]);

  const onScroll = useCallback((e) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 500) onLoadMore?.();
  }, [hasMore, onLoadMore]);

  // Measure a rendered tile's height (constant across tiles).
  const measureRef = useCallback((node) => {
    if (!node) return;
    const h = node.getBoundingClientRect().height;
    if (h && Math.abs(h - tileH) > 1) setTileH(h);
  }, [tileH]);

  const availW = Math.max(0, size.width - PAD * 2);
  const cols = Math.max(1, Math.floor((availW + GAP) / (TILE_MIN + GAP)));
  const rowH = tileH + GAP;
  const totalRows = Math.ceil(images.length / cols);
  const totalHeight = totalRows * rowH;

  const effScroll = Math.max(0, scrollTop - PAD);
  const firstRow = Math.floor(effScroll / rowH);
  const visibleRows = Math.ceil((size.height || 800) / rowH) + 1;
  const startRow = Math.max(0, firstRow - OVERSCAN);
  const endRow = Math.min(totalRows, firstRow + visibleRows + OVERSCAN);
  const visible = images.slice(startRow * cols, Math.min(images.length, endRow * cols));

  // If the loaded content doesn't fill the viewport yet, pull the next page.
  useEffect(() => {
    if (hasMore && totalHeight > 0 && totalHeight <= (size.height || 0)) onLoadMore?.();
  }, [hasMore, totalHeight, size.height, onLoadMore]);

  if (images.length === 0) {
    return (
      <div className="tile-grid-wrap" ref={wrapRef}>
        <div className="empty-state">No images found.</div>
      </div>
    );
  }

  return (
    <div className="tile-grid-wrap" ref={wrapRef} onScroll={onScroll}>
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          className="tile-grid"
          style={{
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${startRow * rowH}px)`,
          }}
        >
          {visible.map((img, i) => (
            <Tile
              key={img.id}
              image={img}
              selected={selectedIds.has(img.id)}
              onSelect={onSelect}
              onOpen={onOpen}
              onFavoriteChange={onFavoriteChange}
              sortedIds={sortedIds}
              innerRef={i === 0 ? measureRef : undefined}
            />
          ))}
        </div>
      </div>
      {!hasMore && (
        <div className="end-label">All {images.length} images loaded</div>
      )}
    </div>
  );
}
