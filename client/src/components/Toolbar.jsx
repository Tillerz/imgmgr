import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import StarRating from './StarRating.jsx';

const SORTS = [
  { value: 'mtime-desc', label: 'Date ↓' },
  { value: 'mtime-asc',  label: 'Date ↑' },
  { value: 'name-asc',   label: 'Name ↑' },
  { value: 'name-desc',  label: 'Name ↓' },
  { value: 'fav-desc',   label: 'Stars ↓' },
  { value: 'fav-asc',    label: 'Stars ↑' },
];

// Dropdown of distinct values for a metadata key (Model, Sampler, …).
function FacetSelect({ label, facetKey, value, onFacet }) {
  const { data: values = [] } = useQuery({
    queryKey: ['metaValues', facetKey],
    queryFn: () => api.metaValues(facetKey),
    staleTime: 60_000,
  });
  if (!values.length) return null;
  // Natural sort by value (case-insensitive, numeric-aware so "20" < "150").
  const sorted = [...values].sort((a, b) =>
    a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' }));
  return (
    <select
      className="select-sm"
      value={value || ''}
      onChange={e => onFacet(facetKey, e.target.value)}
      title={`Filter by ${label}`}
    >
      <option value="">{label}: all</option>
      {sorted.map(v => <option key={v.value} value={v.value}>{v.value} ({v.n})</option>)}
    </select>
  );
}

export default function Toolbar({
  sort, onSort,
  favoriteMin, onFavoriteMin,
  search, onSearch,
  tagFilter, onTagFilter,
  facets = {}, onFacet,
  selectedCount, total, loaded,
  onSelectAll, onDeselectAll,
  onDeleteSelected,
  onBulkRate,
  onCaptionSelected,
  captioning,
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
          placeholder="Search… (e.g. sunset -blurry &quot;close up&quot; caption:castle)"
          title={'Space = AND, -term excludes, "quote" for phrases.\nSearches filename + prompt by default.\nPrefix a term to target one field: caption:, prompt:, name:\nExamples: sunset beach -blurry "close up"  •  caption:"golden hour"  •  dog -caption:cartoon'}
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

        <FacetSelect label="Model" facetKey="Model" value={facets.Model} onFacet={onFacet} />
        <FacetSelect label="Sampler" facetKey="Sampler" value={facets.Sampler} onFacet={onFacet} />
        <FacetSelect label="Steps" facetKey="Steps" value={facets.Steps} onFacet={onFacet} />

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
            <span className="bulk-rate">
              <span className="filter-label">Rate:</span>
              <StarRating value={0} onChange={onBulkRate} size="sm" />
              <button className="btn btn-secondary btn-xs" onClick={() => onBulkRate(0)} title="Clear rating on selected">0★</button>
            </span>

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

            <button
              className="btn btn-secondary btn-sm"
              onClick={onCaptionSelected}
              disabled={!!captioning}
              title="Generate captions for the selected images via SDNext (slow)"
            >
              {captioning ? `Captioning ${captioning.done}/${captioning.total}…` : `✦ Caption ${selectedCount}`}
            </button>

            <button className="btn btn-danger btn-sm" onClick={onDeleteSelected}>
              Delete {selectedCount}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
