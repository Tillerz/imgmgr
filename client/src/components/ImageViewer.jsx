import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import StarRating from './StarRating.jsx';

function MetaPanel({ imageId, image }) {
  const { data: metaRows = [] } = useQuery({
    queryKey: ['metadata', imageId],
    queryFn: () => api.metadata(imageId),
  });

  const [copied, setCopied] = useState(false);

  const allText = [
    image ? `File: ${image.filename}` : '',
    image ? `Path: ${image.path}` : '',
    image ? `Dimensions: ${image.width} × ${image.height}` : '',
    image ? `Size: ${(image.size / 1024).toFixed(1)} KB` : '',
    image ? `Date: ${new Date(image.mtime).toLocaleString()}` : '',
    image?.positive_prompt ? `\nPrompt:\n${image.positive_prompt}` : '',
    image?.negative_prompt ? `\nNegative prompt:\n${image.negative_prompt}` : '',
    metaRows.length ? `\nEXIF:\n${metaRows.map(r => `${r.key}: ${r.value}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  function copyAll() {
    navigator.clipboard.writeText(allText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (!image) return <div className="meta-panel loading">Loading…</div>;

  return (
    <div className="meta-panel">
      <div className="meta-section">
        <div className="meta-file-info">
          <div className="meta-filename">{image.filename}</div>
          <div className="meta-row"><span>Dimensions</span><span>{image.width} × {image.height}</span></div>
          <div className="meta-row"><span>Size</span><span>{(image.size / 1024).toFixed(1)} KB</span></div>
          <div className="meta-row"><span>Date</span><span>{new Date(image.mtime).toLocaleString()}</span></div>
          <div className="meta-row"><span>Folder</span><span className="meta-path">{image.folder_path}</span></div>
        </div>
      </div>

      {image.positive_prompt && (
        <div className="meta-section">
          <div className="meta-section-title">Prompt</div>
          <pre className="meta-prompt">{image.positive_prompt}</pre>
        </div>
      )}

      {image.negative_prompt && (
        <div className="meta-section">
          <div className="meta-section-title">Negative prompt</div>
          <pre className="meta-prompt meta-negative">{image.negative_prompt}</pre>
        </div>
      )}

      {metaRows.length > 0 && (
        <div className="meta-section">
          <div className="meta-section-title">EXIF / Metadata</div>
          <div className="meta-table">
            {metaRows.map(row => (
              <div key={row.key} className="meta-row">
                <span className="meta-key">{row.key}</span>
                <span className="meta-value">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="meta-copy-row">
        <button className="btn btn-secondary btn-sm" onClick={copyAll}>
          {copied ? 'Copied!' : 'Copy all'}
        </button>
      </div>
    </div>
  );
}

export default function ImageViewer({ imageId, imageIds, onClose, onNavigate, onFavoriteChange }) {
  const [zoom, setZoom] = useState(false);
  const imgRef = useRef(null);

  const { data: image } = useQuery({
    queryKey: ['image', imageId],
    queryFn: () => api.image(imageId),
  });

  const currentIdx = imageIds.indexOf(imageId);
  const canPrev = currentIdx > 0;
  const canNext = currentIdx < imageIds.length - 1;

  const nav = useCallback((dir) => {
    const next = imageIds[currentIdx + dir];
    if (next != null) { onNavigate(next); setZoom(false); }
  }, [currentIdx, imageIds, onNavigate]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') nav(-1);
      if (e.key === 'ArrowRight') nav(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, nav]);

  // Prevent body scroll while viewer is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div className="viewer-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="viewer-container">
        <div className="viewer-topbar">
          <div className="viewer-nav">
            <button className="btn-icon" onClick={() => nav(-1)} disabled={!canPrev}>‹</button>
            <span className="viewer-counter">{currentIdx + 1} / {imageIds.length}</span>
            <button className="btn-icon" onClick={() => nav(1)} disabled={!canNext}>›</button>
          </div>
          <div className="viewer-topbar-right">
            {image && (
              <StarRating value={image.favorite} onChange={v => onFavoriteChange(image.id, v)} size="lg" />
            )}
            <button className="btn-icon btn-close" onClick={onClose} title="Close (Esc)">✕</button>
          </div>
        </div>

        <div className="viewer-body">
          <div className={`viewer-image-area ${zoom ? 'zoomed' : ''}`} onClick={() => setZoom(v => !v)}>
            <img
              ref={imgRef}
              src={api.full(imageId)}
              alt={image?.filename || ''}
              className="viewer-img"
              draggable={false}
            />
            <div className="viewer-zoom-hint">{zoom ? 'Click to fit' : 'Click to zoom'}</div>
          </div>

          <MetaPanel imageId={imageId} image={image} />
        </div>
      </div>
    </div>
  );
}
