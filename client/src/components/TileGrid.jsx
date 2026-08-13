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

export default function TileGrid({ images, selectedIds, onSelect, onOpen, onFavoriteChange, onLoadMore, hasMore }) {
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

  // Reset scroll to top when the result set is replaced (filters/folder/trash change).
  const firstId = images[0]?.id;
  useEffect(() => {
    if (wrapRef.current) wrapRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [firstId]);

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
