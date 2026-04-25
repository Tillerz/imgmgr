import React, { useEffect, useRef, useCallback } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { api } from '../api.js';
import StarRating from './StarRating.jsx';

function Tile({ image, selected, onSelect, onOpen, onFavoriteChange, sortedIds }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: image.id,
    data: { type: 'image', id: image.id },
  });

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

  const date = image.mtime ? new Date(image.mtime).toLocaleDateString() : '';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`tile ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`}
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
        <div className="tile-select-btn" onClick={handleSelectClick} title="Select">◻</div>
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
  const sentinelRef = useRef(null);
  const sortedIds = images.map(i => i.id);

  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;
    const obs = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) onLoadMore(); },
      { rootMargin: '200px' }
    );
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [hasMore, onLoadMore]);

  if (images.length === 0) {
    return <div className="empty-state">No images found.</div>;
  }

  return (
    <div className="tile-grid-wrap">
      <div className="tile-grid">
        {images.map(img => (
          <Tile
            key={img.id}
            image={img}
            selected={selectedIds.has(img.id)}
            onSelect={onSelect}
            onOpen={onOpen}
            onFavoriteChange={onFavoriteChange}
            sortedIds={sortedIds}
          />
        ))}
      </div>
      {hasMore && <div ref={sentinelRef} className="sentinel" />}
      {!hasMore && images.length > 0 && (
        <div className="end-label">All {images.length} images loaded</div>
      )}
    </div>
  );
}
