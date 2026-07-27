import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

function DuplicateGroup({ group, selected, onToggle, onKeepFirst }) {
  return (
    <div className="dup-group">
      <div className="dup-group-header">
        <span className="dup-type-badge">{group.type}</span>
        {group.seed && <span className="dup-seed" title="Seed value">seed {group.seed}</span>}
        <span>{group.images.length} copies</span>
        <button className="btn btn-secondary btn-xs" onClick={onKeepFirst}>Keep oldest, select rest</button>
      </div>
      <div className="dup-images">
        {group.images.map(img => (
          <div
            key={img.id}
            className={`dup-tile ${selected.has(img.id) ? 'selected' : ''}`}
            onClick={() => onToggle(img.id)}
          >
            <img src={api.thumb(img.id)} alt={img.filename} loading="lazy" />
            <div className="dup-tile-info">
              <span title={img.path}>{img.filename}</span>
              <span>{(img.size / 1024).toFixed(0)} KB</span>
              <span>{img.width}×{img.height}</span>
              <span>{new Date(img.mtime).toLocaleDateString()}</span>
            </div>
            {selected.has(img.id) && <div className="dup-check">✕</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DuplicatePanel({ onClose, onDeleted }) {
  const qc = useQueryClient();
  const [dupType, setDupType] = useState('exact');
  const [selected, setSelected] = useState(new Set()); // spans all groups

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['duplicates', dupType],
    queryFn: () => api.duplicates(dupType),
  });

  const groups = data?.groups || [];

  // Clear the selection when switching duplicate type.
  useEffect(() => { setSelected(new Set()); }, [dupType]);

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Select every copy except the oldest (first) within one group.
  function keepFirst(group) {
    setSelected(prev => {
      const next = new Set(prev);
      group.images.slice(1).forEach(i => next.add(i.id));
      return next;
    });
  }

  // Same, but across every group shown.
  function keepOldestAll() {
    const next = new Set();
    groups.forEach(g => g.images.slice(1).forEach(i => next.add(i.id)));
    setSelected(next);
  }

  async function handleDelete() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} image(s)? They move to the trash and can be restored.`)) return;
    const res = await api.deleteDuplicates(ids); // starred images are protected server-side
    setSelected(new Set());
    refetch();
    onDeleted();
    if (res?.skipped?.length) {
      window.alert(`${res.skipped.length} starred image(s) were protected and not deleted.`);
    }
  }

  return (
    <div className="viewer-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dup-panel">
        <div className="dup-panel-header">
          <h2>Duplicate Finder</h2>
          <div className="dup-type-toggle">
            <button className={`btn btn-sm ${dupType === 'exact'      ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDupType('exact')}>Exact</button>
            <button className={`btn btn-sm ${dupType === 'perceptual' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDupType('perceptual')}>Visual</button>
            <button className={`btn btn-sm ${dupType === 'seed'       ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDupType('seed')}>Seed</button>
          </div>
          <button className="btn-icon btn-close" onClick={onClose}>✕</button>
        </div>

        {groups.length > 0 && (
          <div className="dup-actions">
            <span className="dup-actions-label">
              {groups.length} group{groups.length > 1 ? 's' : ''}
              {selected.size > 0 && ` · ${selected.size} selected`}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={keepOldestAll}>
              Keep oldest in all, select rest
            </button>
            <button className="btn btn-secondary btn-sm" disabled={!selected.size} onClick={() => setSelected(new Set())}>
              Clear
            </button>
            <button className="btn btn-danger btn-sm" disabled={!selected.size} onClick={handleDelete}>
              Delete {selected.size} selected
            </button>
          </div>
        )}

        <div className="dup-panel-body">
          {isLoading && <div className="loading-msg">Searching for duplicates…</div>}
          {!isLoading && groups.length === 0 && <div className="empty-state">No duplicates found.</div>}
          {groups.map((g, i) => (
            <DuplicateGroup
              key={i}
              group={g}
              selected={selected}
              onToggle={toggle}
              onKeepFirst={() => keepFirst(g)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
