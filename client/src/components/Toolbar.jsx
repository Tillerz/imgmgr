import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

const SORTS = [
  { value: 'mtime-desc', label: 'Date ↓' },
  { value: 'mtime-asc',  label: 'Date ↑' },
  { value: 'name-asc',   label: 'Name ↑' },
  { value: 'name-desc',  label: 'Name ↓' },
  { value: 'fav-desc',   label: 'Stars ↓' },
  { value: 'fav-asc',    label: 'Stars ↑' },
];

export default function Toolbar({
  sort, onSort,
  favoriteMin, onFavoriteMin,
  search, onSearch,
  tagFilter, onTagFilter,
  selectedCount, total, loaded,
  onSelectAll, onDeselectAll,
  onDeleteSelected,
  currentFolder,
  onMoveToFolder,
  onBulkTag,
  hasNewImages,
  onRefreshNew,
}) {
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [tagInput, setTagInput] = useState('');

  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: api.folders,
    enabled: showMoveMenu,
  });

  const { data: counts = {} } = useQuery({
    queryKey: ['favCounts', currentFolder, search],
    queryFn: () => api.favoriteCounts({ folder: currentFolder, search }),
    staleTime: 10_000,
  });

  const { data: allTags = [] } = useQuery({
    queryKey: ['allTags'],
    queryFn: api.allTags,
    staleTime: 30_000,
  });

  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const unratedCount = counts[0] ?? 0;

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <input
          className="search-input"
          type="search"
          placeholder="Search prompts & filenames…"
          value={search}
          onChange={e => onSearch(e.target.value)}
        />

        <select className="select-sm" value={sort} onChange={e => onSort(e.target.value)}>
          {SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        {allTags.length > 0 && (
          <select
            className="select-sm"
            value={tagFilter}
            onChange={e => onTagFilter(e.target.value)}
            title="Filter by tag"
          >
            <option value="">All tags</option>
            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}

        <div className="star-filter">
          <span className="filter-label">Min ★</span>
          <button
            className={`star-filter-btn ${favoriteMin === 0 ? 'active' : ''}`}
            onClick={() => onFavoriteMin(0)}
          >
            All <span className="star-count">({totalCount})</span>
          </button>
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              className={`star-filter-btn ${favoriteMin === n ? 'active' : ''}`}
              onClick={() => onFavoriteMin(n)}
            >
              {'★'.repeat(n)} <span className="star-count">({counts[n] ?? 0})</span>
            </button>
          ))}
          {unratedCount > 0 && (
            <span className="unrated-count" title="Images with no stars">☆ {unratedCount}</span>
          )}
        </div>
      </div>

      {hasNewImages && (
        <div className="new-images-banner" onClick={onRefreshNew}>
          ↻ New images available — click to refresh
        </div>
      )}

      <div className="toolbar-row toolbar-actions">
        <span className="count-label">
          {loaded} / {total} images
          {selectedCount > 0 && ` · ${selectedCount} selected`}
        </span>

        <button className="btn btn-secondary btn-sm" onClick={onSelectAll}>All</button>
        <button className="btn btn-secondary btn-sm" onClick={onDeselectAll}>None</button>

        {selectedCount > 0 && (
          <>
            <div className="move-menu-wrap">
              <button className="btn btn-primary btn-sm" onClick={() => setShowMoveMenu(v => !v)}>
                Move {selectedCount} →
              </button>
              {showMoveMenu && (
                <div className="move-menu">
                  {folders.map(f => (
                    <div
                      key={f.id}
                      className="move-menu-item"
                      onClick={() => { onMoveToFolder(f.path); setShowMoveMenu(false); }}
                    >
                      📁 {f.name}
                      <span className="move-menu-path">{f.path}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="move-menu-wrap">
              <button className="btn btn-secondary btn-sm" onClick={() => setShowTagMenu(v => !v)}>
                Tag {selectedCount} →
              </button>
              {showTagMenu && (
                <div className="move-menu tag-bulk-menu">
                  <div className="tag-bulk-input-row">
                    <input
                      className="tag-input"
                      type="text"
                      placeholder="Tag name…"
                      value={tagInput}
                      onChange={e => setTagInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { onBulkTag(tagInput, 'add'); setTagInput(''); } }}
                      autoFocus
                    />
                  </div>
                  <div className="tag-bulk-actions">
                    <button
                      className="btn btn-primary btn-xs"
                      disabled={!tagInput.trim()}
                      onClick={() => { onBulkTag(tagInput, 'add'); setTagInput(''); }}
                    >
                      + Add to {selectedCount}
                    </button>
                    <button
                      className="btn btn-secondary btn-xs"
                      disabled={!tagInput.trim()}
                      onClick={() => { onBulkTag(tagInput, 'remove'); setTagInput(''); }}
                    >
                      − Remove from {selectedCount}
                    </button>
                  </div>
                  {allTags.length > 0 && (
                    <div className="tag-bulk-existing">
                      {allTags.map(t => (
                        <span
                          key={t}
                          className={`tag-chip tag-chip-pick ${tagInput === t ? 'active' : ''}`}
                          onClick={() => setTagInput(t)}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button className="btn btn-danger btn-sm" onClick={onDeleteSelected}>
              Delete {selectedCount}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
