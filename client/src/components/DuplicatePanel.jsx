import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

function DuplicateGroup({ group, onDelete }) {
  const [selected, setSelected] = useState(new Set());

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function keepFirst() {
    const toDelete = group.images.slice(1).map(i => i.id);
    setSelected(new Set(toDelete));
  }

  return (
    <div className="dup-group">
      <div className="dup-group-header">
        <span className="dup-type-badge">{group.type}</span>
        {group.seed && <span className="dup-seed" title="Seed value">seed {group.seed}</span>}
        <span>{group.images.length} copies</span>
        <button className="btn btn-secondary btn-xs" onClick={keepFirst}>Keep oldest, select rest</button>
        <button
          className="btn btn-danger btn-xs"
          disabled={selected.size === 0}
          onClick={() => onDelete([...selected])}
        >
          Delete {selected.size} selected
        </button>
      </div>
      <div className="dup-images">
        {group.images.map(img => (
          <div
            key={img.id}
            className={`dup-tile ${selected.has(img.id) ? 'selected' : ''}`}
            onClick={() => toggle(img.id)}
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

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['duplicates', dupType],
    queryFn: () => api.duplicates(dupType),
  });

  async function handleDelete(ids) {
    if (!window.confirm(`Delete ${ids.length} image(s)?`)) return;
    const res = await api.deleteDuplicates(ids); // starred images are protected server-side
    refetch();
    onDeleted();
    if (res?.skipped?.length) {
      window.alert(`${res.skipped.length} starred image(s) were protected and not deleted.`);
    }
  }

  const groups = data?.groups || [];

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

        <div className="dup-panel-body">
          {isLoading && <div className="loading-msg">Searching for duplicates…</div>}
          {!isLoading && groups.length === 0 && <div className="empty-state">No duplicates found.</div>}
          {groups.map((g, i) => (
            <DuplicateGroup key={i} group={g} onDelete={handleDelete} />
          ))}
        </div>
      </div>
    </div>
  );
}
